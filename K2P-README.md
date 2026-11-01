# K2P OpenWrt 固件 —— 网络加速 + EasyTier

斐讯 K2P A1/A2（MT7621A + MT7615D / 16MB NOR / 128MB RAM）专用固件。

基线 `openwrt/openwrt` **v23.05.6**，分支 `k2p-accel`。

---

## 这个固件解决什么

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
| 游戏 UDP 加速 | 不做（迅游闭源 SDK 无法移植） | — |

结果是：**任何设备接上这个路由器就生效，一台都不需要装根证书**，包括 PS5、Xbox、
电视盒子这类根本装不了证书的设备。

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
| **本固件实测** | 见 Release 里的 `size-report.md` |

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
