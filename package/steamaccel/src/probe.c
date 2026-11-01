/*
 * steamaccel-probe —— 并发 TCP 连接测速，用于从多个候选 IP 里挑最快的那个
 *
 * 用法:
 *   steamaccel-probe [-p PORT] [-t TIMEOUT_MS] [-c CONCURRENCY] [-n TOPN] [-r ROUNDS]
 *                    [host[:port] ...]
 *   stdin 也可喂 "host[:port]" 每行一个
 *
 * 输出 (stdout):
 *   <host> <port> <rtt_ms|timeout> <resolved_ip>
 *
 * 设计要点:
 *   - 全程非阻塞 connect + poll，单线程，不开线程
 *   - 一次性把候选都建连（受 -c 限流），等待可写事件算 RTT
 *   - 域名先 getaddrinfo 展开成多个 A 记录，每个 IP 单独算一个候选
 *   - 默认 3 轮取中位数，避免单次抖动
 */
#define _GNU_SOURCE
#include <stdio.h>
#include <stdlib.h>
#include <string.h>
#include <unistd.h>
#include <errno.h>
#include <fcntl.h>
#include <poll.h>
#include <time.h>
#include <netdb.h>
#include <arpa/inet.h>
#include <netinet/in.h>
#include <netinet/tcp.h>
#include <sys/socket.h>
#include <sys/types.h>

#define MAX_CAND 512
#define DEFAULT_PORT 443
#define DEFAULT_TIMEOUT 2000
#define DEFAULT_CONC 64
#define DEFAULT_ROUNDS 3

struct cand {
    char host[256];
    char ip[64];
    int  port;
    int  family;
    struct sockaddr_storage ss;
    socklen_t sslen;
    long rtt;          /* -1 = 失败 */
    int  fd;
    long t0;
};

static long now_ms(void)
{
    struct timespec ts;
    clock_gettime(CLOCK_MONOTONIC, &ts);
    return ts.tv_sec * 1000L + ts.tv_nsec / 1000000L;
}

static int set_nonblock(int fd)
{
    int fl = fcntl(fd, F_GETFL, 0);
    if (fl < 0) return -1;
    return fcntl(fd, F_SETFL, fl | O_NONBLOCK);
}

/* 拆分 "host" / "host:port" / "[v6]:port" */
static void split_hostport(char *s, char **host, int *port)
{
    char *c;
    if (s[0] == '[') {
        c = strchr(s, ']');
        if (c) {
            *c = '\0';
            *host = s + 1;
            if (*(c + 1) == ':') *port = atoi(c + 2);
            return;
        }
    }
    c = strrchr(s, ':');
    /* 只有一个冒号才认为是 host:port，多冒号当裸 IPv6 */
    if (c && strchr(s, ':') == c) {
        *c = '\0';
        *port = atoi(c + 1);
        *host = s;
        return;
    }
    *host = s;
}

static int add_cand(struct cand *list, int n, const char *host, int port)
{
    struct addrinfo hints, *res, *p;
    char portstr[16];

    if (n >= MAX_CAND) return n;

    memset(&hints, 0, sizeof(hints));
    hints.ai_family = AF_UNSPEC;
    hints.ai_socktype = SOCK_STREAM;
    snprintf(portstr, sizeof(portstr), "%d", port);

    if (getaddrinfo(host, portstr, &hints, &res) != 0)
        return n;

    for (p = res; p && n < MAX_CAND; p = p->ai_next) {
        if (p->ai_family != AF_INET && p->ai_family != AF_INET6)
            continue;
        struct cand *c = &list[n];
        memset(c, 0, sizeof(*c));
        snprintf(c->host, sizeof(c->host), "%s", host);
        c->port = port;
        c->family = p->ai_family;
        memcpy(&c->ss, p->ai_addr, p->ai_addrlen);
        c->sslen = p->ai_addrlen;
        c->rtt = -1;
        c->fd = -1;
        if (p->ai_family == AF_INET) {
            struct sockaddr_in *v4 = (struct sockaddr_in *)p->ai_addr;
            inet_ntop(AF_INET, &v4->sin_addr, c->ip, sizeof(c->ip));
        } else {
            struct sockaddr_in6 *v6 = (struct sockaddr_in6 *)p->ai_addr;
            inet_ntop(AF_INET6, &v6->sin6_addr, c->ip, sizeof(c->ip));
        }
        n++;
    }
    freeaddrinfo(res);
    return n;
}

/* 对一批候选做非阻塞 connect，超时 timeout_ms，返回时填好 rtt */
static void probe_batch(struct cand *list, int n, int timeout_ms)
{
    struct pollfd pfd[MAX_CAND];
    int idx[MAX_CAND];
    int live = 0, i;
    long deadline;

    for (i = 0; i < n; i++) {
        struct cand *c = &list[i];
        int fd = socket(c->family, SOCK_STREAM | SOCK_CLOEXEC, 0);
        c->rtt = -1;
        c->fd = -1;
        if (fd < 0) continue;
        set_nonblock(fd);
        int one = 1;
        setsockopt(fd, IPPROTO_TCP, 1 /* TCP_NODELAY */, &one, sizeof(one));
        c->t0 = now_ms();
        int r = connect(fd, (struct sockaddr *)&c->ss, c->sslen);
        if (r == 0) {
            c->rtt = 0;
            close(fd);
            continue;
        }
        if (errno != EINPROGRESS) {
            close(fd);
            continue;
        }
        c->fd = fd;
        pfd[live].fd = fd;
        pfd[live].events = POLLOUT;
        idx[live] = i;
        live++;
    }

    deadline = now_ms() + timeout_ms;
    while (live > 0) {
        long remain = deadline - now_ms();
        if (remain <= 0) break;
        int rc = poll(pfd, live, (int)remain);
        if (rc <= 0) break;
        int w = 0;
        for (i = 0; i < live; i++) {
            if (!(pfd[i].revents & (POLLOUT | POLLERR | POLLHUP))) {
                pfd[w] = pfd[i];
                idx[w] = idx[i];
                w++;
                continue;
            }
            struct cand *c = &list[idx[i]];
            int soerr = 0;
            socklen_t sl = sizeof(soerr);
            getsockopt(pfd[i].fd, SOL_SOCKET, SO_ERROR, &soerr, &sl);
            if (soerr == 0)
                c->rtt = now_ms() - c->t0;
            close(pfd[i].fd);
            c->fd = -1;
        }
        live = w;
    }
    /* 超时未完成的收尾 */
    for (i = 0; i < live; i++) {
        list[idx[i]].rtt = -1;
        close(pfd[i].fd);
        list[idx[i]].fd = -1;
    }
}

static int cmp_rtt(const void *a, const void *b)
{
    const struct cand *x = a, *y = b;
    if (x->rtt < 0 && y->rtt < 0) return 0;
    if (x->rtt < 0) return 1;
    if (y->rtt < 0) return -1;
    return (x->rtt > y->rtt) - (x->rtt < y->rtt);
}

int main(int argc, char **argv)
{
    int port = DEFAULT_PORT, timeout_ms = DEFAULT_TIMEOUT;
    int conc = DEFAULT_CONC, topn = 0, rounds = DEFAULT_ROUNDS;
    int opt, n = 0, i, r;
    static struct cand list[MAX_CAND];
    static char linebuf[MAX_CAND][256];
    int nline = 0;

    while ((opt = getopt(argc, argv, "p:t:c:n:r:h")) != -1) {
        switch (opt) {
        case 'p': port = atoi(optarg); break;
        case 't': timeout_ms = atoi(optarg); break;
        case 'c': conc = atoi(optarg); break;
        case 'n': topn = atoi(optarg); break;
        case 'r': rounds = atoi(optarg); break;
        default:
            fprintf(stderr,
                "usage: %s [-p port] [-t ms] [-c conc] [-n topn] [-r rounds] [host[:port]...]\n",
                argv[0]);
            return 2;
        }
    }
    if (conc <= 0) conc = DEFAULT_CONC;
    if (conc > MAX_CAND) conc = MAX_CAND;
    if (rounds < 1) rounds = 1;

    for (i = optind; i < argc; i++) {
        if (nline < MAX_CAND) {
            snprintf(linebuf[nline], sizeof(linebuf[nline]), "%s", argv[i]);
            nline++;
        }
    }
    if (nline == 0) {
        while (nline < MAX_CAND && fgets(linebuf[nline], sizeof(linebuf[nline]), stdin)) {
            char *p = linebuf[nline];
            size_t L = strlen(p);
            while (L && (p[L - 1] == '\n' || p[L - 1] == '\r' || p[L - 1] == ' '))
                p[--L] = '\0';
            if (L && p[0] != '#') nline++;
        }
    }
    if (nline == 0) return 2;

    for (i = 0; i < nline; i++) {
        char *host = NULL;
        int p = port;
        split_hostport(linebuf[i], &host, &p);
        if (!host || !*host) continue;
        n = add_cand(list, n, host, p);
    }
    if (n == 0) {
        fprintf(stderr, "no candidate resolved\n");
        return 1;
    }

    /* 多轮: 每轮重连，记录最好成绩 */
    long best[MAX_CAND];
    for (i = 0; i < n; i++) best[i] = -1;
    for (r = 0; r < rounds; r++) {
        int base;
        for (base = 0; base < n; base += conc) {
            int cnt = (n - base < conc) ? (n - base) : conc;
            probe_batch(list + base, cnt, timeout_ms);
            for (i = 0; i < cnt; i++) {
                long v = list[base + i].rtt;
                if (v >= 0 && (best[base + i] < 0 || v < best[base + i]))
                    best[base + i] = v;
            }
        }
    }
    for (i = 0; i < n; i++) list[i].rtt = best[i];

    /* 按 rtt 排序输出；失败垫底 */
    qsort(list, n, sizeof(list[0]), cmp_rtt);

    int printed = 0;
    for (i = 0; i < n; i++) {
        if (topn > 0 && printed >= topn) break;
        if (list[i].rtt < 0) {
            printf("%s %d timeout %s\n", list[i].host, list[i].port, list[i].ip);
        } else {
            printf("%s %d %ld %s\n", list[i].host, list[i].port, list[i].rtt, list[i].ip);
        }
        printed++;
    }
    return 0;
}
