# K2P OpenWrt 固件 —— 规则加速 + WireGuard 出口 + EasyTier

斐讯 K2P A1/A2（MT7621A + MT7615D / 16MB NOR / 128MB RAM）专用固件。

基线 `openwrt/openwrt` **v23.05.6**，分支 `k2p-accel`。

---

## 这个固件解决什么

分两层，解决的是两类完全不同的问题。

**第一层：规则加速**（`steamaccel`）—— 把特定域名指到能通的镜像，不加密、不解密。

PC 上的 Watt Toolkit（原 Steam++）加速 Steam 社区/商店的方式是：
改 hosts 把域名指到 `127.0.0.1` → 本机起 Kestrel 反代 → 自签根证书做 TLS 中间人 → 换个能通的上游。

装到路由器上时，**中间人那一层不做**。因为 MITM 的唯一目的是改写 HTML 和伪造 UA，
而路由器只需要「把连接导去一个更好的上游」—— 那是名字解析层的事。

| PC 版能力 | 本固件做法 | 需要证书 |
|---|---|---|
| hosts 指到 127.0.0.1 + 本地反代 | dnsmasq `cname` / `address` 改写 | 否 |
| 多 IP 并发测速选最快 | `steamaccel-probe` 并发 TCP 握手测 RTT | 否 |
| 规则远程下发 | `POST api.steampp.net/accelerator/projectgroups` | 否 |
| 内容改写（注入脚本） | 不做 | — |
| UA 伪造 | 不做 | — |

**第二层：出口**（`warp-wg`）—— 真正把流量送到境外，覆盖全部站点。

规则加速只能救「有第三方公益反代可用」的域名，Google / YouTube / Telegram 这类
没有任何人给你做反代的站点，改 DNS 是救不回来的 —— 必须真有一个境外出口。

这一层用内核 WireGuard：**国内 IP 直连，其余全部走隧道**。
判断依据是目的 IP 落在不落在 3888 条国内段里，**不依赖任何域名清单**，
所以「支持多少站点」这个问题不存在 —— 不在国内的全走隧道。

结果是：**任何设备接上这个路由器就生效，一台都不需要装根证书**，包括 PS5、Xbox、
电视盒子这类根本装不了证书的设备。

| 需求 | 做法 | 说明 |
|---|---|---|
| 日常上外网（Google / YouTube 等） | 隧道 + IP 分流 | 全网覆盖 |
| Steam 社区/商店 | 规则加速 | 优先直连，隧道不抢这些 IP |
| 游戏（UDP 联机） | 隧道带 UDP | WireGuard 是三层隧道，UDP 天然支持；延迟取决于出口线路 |
| 流媒体解锁 | 不保证 | WARP 出口不解锁 Netflix 等版权区 |

---

## 组成部分

### package/steamaccel

| 文件 | 作用 |
|---|---|
| `src/probe.c` | 并发 TCP 连接测速，给写死 IP 的规则挑最快的 |
| `files/gen.lua` | 规则 JSON → dnsmasq 配置 / nginx SNI map |
| `files/steamaccel-update` | 拉规则（三重退路：POST → --method POST → 自建镜像） |
| `files/steamaccel-apply` | 渲染 → 探活 → 写 `/tmp/dnsmasq.d/` → reload |
| `files/steamaccel.init` | 开机应用 + 装 cron 定时更新 |
| `files/rules.json` | 内置规则快照，接口拉不到时的兜底 |

**生成策略**

- 上游是 IP → `address=/源域名/IP`
- 上游是域名 + 源域名精确 → `cname=源域名,上游域名`（让客户端自己解析，保留 CDN 就近）
- 上游是域名 + 源域名带 `*.` → 解析上游后 `address=/基域名/IP`（dnsmasq 不支持通配 cname）

**回退原则**：探活连不通的上游不写进配置，让域名走正常 DNS 解析。宁可慢，不要死。

### package/easytier

easytier-lite 静态 ELF（6,698,364 B），procd + UCI。

```sh
uci set easytier.main.enabled=1
uci set easytier.main.network_name='你的网络名'
uci set easytier.main.network_secret='你的密码'
uci set easytier.main.ipv4='10.144.144.1'
uci add_list easytier.main.peers='tcp://public.easytier.cn:11010'
uci commit easytier
/etc/init.d/easytier restart
```

### package/warp-wg

出口层。内核 WireGuard + nftables 分流，**没有用户态代理进程**。

| 文件 | 作用 |
|---|---|
| `files/warp-register` | 自己生成 x25519 密钥对，调 Cloudflare 注册接口拿 WARP 账号 |
| `files/warp-scan` | 逐个试 27 个 endpoint 候选（2408/500/1701/4500 多端口），靠握手判断 |
| `files/warp-route` | nftables set + fwmark + 策略路由，国内直连其余走隧道 |
| `files/warp-status` | 状态汇总，命令行与 LuCI 共用 |
| `files/warp-wg.init` | procd 服务 + 看门狗 |
| `files/chnroute.txt` | 3888 条国内 IPv4 段（BGP 聚合） |
| `files/cn-domains.txt` | 国内域名，决定 DNS 走哪个上游 |

**为什么不用 mihomo / sing-box**

sing-box 1.14.4 的 linux-mipsle 压缩包 24 MB，解压后约 40 MB，squashfs 压完还要 7-8 MiB，
而分区只剩 6.7 MiB。内核 WireGuard 一共 150 KB，且是内核态转发 —— MT7621 上
内核 WireGuard 能跑 50-80 Mbps，用户态代理在同一个 CPU 上只有 20-40 Mbps。

**分流原理**

分三级，先走免费的，走不通才用兜底的。

| 优先级 | 命中条件 | 去向 | 说明 |
|---|---|---|---|
| 1 | 域名命中 steamaccel 规则 | **直连**（公益反代 / 优选 IP） | IP 进 nft `fast` 集合，在 cn 判断之前放行 |
| 2 | IP 在国内段 | **直连** | 3888 条 BGP 聚合段 |
| 3 | 以上都不命中 | **走 WARP 隧道** | 打 mark 0x77 → 表 77 → warp0 |

```sh
# 1. 规则通道优先（免费反代，直连最快）
nft add rule inet warp pre ip daddr @fast return
# 2. 国内直连
nft add rule inet warp pre ip daddr @cn4 return
# 3. 其余打标走隧道
nft add rule inet warp pre meta mark set 0x77
# 策略路由
ip rule add fwmark 0x77 lookup 77 priority 100
ip route replace default dev warp0 table 77
```

**「走不通才走 WARP」是怎么自动发生的**

不需要额外的健康检查逻辑，靠 steamaccel 的探活就够了：

```
反代挂了
  → steamaccel 探活 TCP 443 失败
  → 把这条规则整条剔除，不写进 dnsmasq
  → 域名回到 warp-dns.conf 的 server= 分支
  → 经隧道用 1.1.1.1 解析真实 IP（不污染）
  → 真实 IP 不在 fast、不在 cn → 走隧道 → 通
```

这也是为什么 cname 类规则现在也探活 —— 以前只验写死 IP 的那些，
而 cname 恰恰是「反代挂了但域名还解析得到」的情况，不验就会写死一条死路。

关键点：**绝不改动系统默认路由**。只建独立的表 77，隧道挂了整网自动回到直连，
不会出现「加速器一挂、全家断网」。

**DNS 一并处理**

只做 IP 分流是不够的 —— 解析若先被污染，拿到的是假 IP，走隧道也连不上真站点。
所以隧道起来时同时切换 DNS：

```
国内域名  → 223.5.5.5（就近 CDN）
其余域名  → 1.1.1.1（经隧道，不被污染）
```

**用法**

```sh
warp-register        # 注册 WARP，拿到账号
warp-scan            # 优选一个能握手的 endpoint
uci set warp-wg.cfg.enabled=1
uci commit warp-wg
/etc/init.d/warp-wg restart
warp-status          # 看握手、流量、规则条数
```

或者直接在 LuCI「服务 → 网络加速 → 出口（WARP）」点三个按钮。

**换成自己的节点**：任何标准 WireGuard 服务端都能直接替换 —— 把
`private_key` / `peer_public_key` / `endpoint` / `address4` 填成自己的即可，
分流、DNS、看门狗全部复用。

### package/luci-app-steamaccel

LuCI 页面在「服务 → 网络加速」，可改规则源、更新间隔、探活开关、SNI 分流，
并显示当前生效条数与上次更新时间。

---

## 编译

推送到 `k2p-accel` 分支会自动触发 `.github/workflows/build-k2p.yml`，也可以手动：

```sh
gh workflow run build-k2p.yml -R thisxxx/openwrt --ref k2p-accel
```

本地编译（需要 ~25GB 空间、2 小时）：

```sh
cp feeds.conf.default feeds.conf
sed -i 's|https://git.openwrt.org/feed/packages.git|https://github.com/openwrt/packages.git|' feeds.conf
sed -i 's|https://git.openwrt.org/project/luci.git|https://github.com/openwrt/luci.git|' feeds.conf
./scripts/feeds update -a && ./scripts/feeds install -a

cat > .config <<'EOF'
CONFIG_TARGET_ramips=y
CONFIG_TARGET_ramips_mt7621=y
CONFIG_TARGET_ramips_mt7621_DEVICE_phicomm_k2p=y
CONFIG_TARGET_SQUASHFS_BLOCK_SIZE=512
CONFIG_PACKAGE_luci=y
CONFIG_PACKAGE_luci-ssl=y
EOF
make defconfig
make -j$(nproc)
```

产物：`bin/targets/ramips/mt7621/*phicomm_k2p*squashfs-sysupgrade.bin`

---

## 刷机

> K2P **B1 是博通方案，绝对不能刷**。只有 A1/A2（MT7621）能用。

1. 断电，按住 reset 不放，插电，约 5 秒后松开，进 Breed（`http://192.168.1.1`）
2. **先备份 EEPROM 和 full flash** —— K2P 的 EEPROM 绑定 MT7615 校准数据，丢了无线就废
3. 「固件更新」选 sysupgrade.bin 上传
4. 首次进入管理页 `http://192.168.1.1`（OpenWrt 默认，不是 Padavan 的 192.168.2.1）

从 Padavan 换过来时建议先刷 sysupgrade 一次再做一次「恢复到出厂设置」，
避免两边配置残留打架。

---

## 体积

| 项 | 值 |
|---|---|
| firmware 分区 | 16,121,856 B（15.375 MiB，`0xa0000 + 0xf60000`） |
| `IMAGE_SIZE` | 15744k（与上一致） |
| 官方 v23.05.6 基座 | 7,012,938 B |
| easytier-lite | 6,698,364 B（压缩后约 1.9 MiB） |
| warp-wg（脚本 + IP 段） | 约 140 KB（压缩后约 30 KB） |
| kmod-wireguard + wireguard-tools | 约 150 KB |
| steamaccel + luci | 约 60 KB |
| **本固件实测** | 见 Release 里的 `size-report.md` |

预算约 8.9 MiB，分区 15.375 MiB，余量 6 MiB 以上。

squashfs 块大小从默认 256 KiB 提到 512 KiB：Rust/Go 这类静态大二进制
（符号表、字符串表、pclntab）跨块才有冗余，256K 块会把压缩率吃掉一截。

---

## 已知限制

1. **规则失效仍然会发生**。上游是第三方公益反代，作者改规则、反代关停，都会让某条规则失效。
   固件能做的只是「失效后自动退回正常解析」，不能无中生有。
2. **`FakeServerName` 类规则在 DNS 层实现不了**。API 里约三分之一的规则带这个字段
   （比如把 SNI 伪装成 `steamstore-a.akamaihd.net` 绕 SNI 阻断），改 SNI 必须自己发起握手，
   那就回到 MITM 了，本固件不做。这类规则需要开 SNI 分流，且只能沿用客户端原始 SNI。
3. **游戏下载速度不受影响**。Steam 下载走客户端自选的 CDN，改 DNS 管不到，
   想让下载变快得在 Steam 客户端里手动换下载区域。
4. **规则接口没有版本号**。响应头无 ETag / Cache-Control，每次都是全量 28 KB，
   只能整份比对判断变没变。
5. **WARP 在国内不一定连得上**。Cloudflare 的 WARP 边缘这两年封锁程度不稳定，
   能不能通完全看当地运营商。`warp-scan` 提供 27 个候选（含 500/1701/4500 端口变体），
   全不通就只能换自己的节点。这不是固件能解决的问题。
6. **WARP 不解锁流媒体**。Cloudflare 的出口 IP 会被 Netflix / Disney+ 识别为数据中心，
   想看流媒体版权内容得换有机场节点或自建。
7. **隧道不加速游戏**。WireGuard 三层隧道能带 UDP，游戏能走，
   但延迟取决于出口绕行距离 —— WARP 出口多在美西，国内游戏走它反而更高。
   真要做游戏加速需要的是就近的游戏专线（迅游那种），本固件做不到。
8. **MT7621 没有 AES 指令集**。WireGuard 默认用 ChaCha20-Poly1305，
   在这个 CPU 上约 50-80 Mbps 上限，跑满百兆宽带够用，跑千兆不够。
