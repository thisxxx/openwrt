#
# warp-wg - Cloudflare WARP over kernel WireGuard, with China-route split
#
# 设计要点：
#   1. 出口走内核 WireGuard，用户态零开销，MT7621 上性能远好于任何 TUN 类代理
#   2. 分流靠 nftables set + fwmark + 策略路由，不依赖 DNS，域名被污染也能救回来
#   3. 不接管全局默认路由，只对打了标记的流量走隧道，避免断网
#   4. WARP 只是零成本兜底出口；任何标准 WG 服务端都能直接填进来替换
#
include $(TOPDIR)/rules.mk

PKG_NAME:=warp-wg
PKG_VERSION:=1.0.0
PKG_RELEASE:=1
PKG_LICENSE:=MIT
PKG_MAINTAINER:=thisxxx

include $(INCLUDE_DIR)/package.mk

define Package/warp-wg
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=VPN
  TITLE:=WireGuard 出口（含 Cloudflare WARP 一键注册与国内直连分流）
  DEPENDS:=+kmod-wireguard +wireguard-tools +nftables +curl
  PKGARCH:=all
endef

define Package/warp-wg/description
  用内核 WireGuard 做出口，附带 Cloudflare WARP 免费账号自助注册、
  endpoint 自动优选、以及基于 3888 条国内 IP 段的策略路由分流。
  大陆 IP 直连，其余全部走隧道，因此覆盖全部境外站点，不依赖域名清单。
endef

define Package/warp-wg/conffiles
/etc/config/warp-wg
endef

define Build/Compile
endef

define Package/warp-wg/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/warp-register       $(1)/usr/bin/warp-register
	$(INSTALL_BIN) ./files/warp-scan           $(1)/usr/bin/warp-scan
	$(INSTALL_BIN) ./files/warp-route          $(1)/usr/bin/warp-route
	$(INSTALL_BIN) ./files/warp-status         $(1)/usr/bin/warp-status

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/warp-wg.init        $(1)/etc/init.d/warp-wg

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/warp-wg.config     $(1)/etc/config/warp-wg

	$(INSTALL_DIR) $(1)/etc/warp-wg
	$(INSTALL_DATA) ./files/chnroute.txt       $(1)/etc/warp-wg/chnroute.txt
	$(INSTALL_DATA) ./files/chnroute6.txt      $(1)/etc/warp-wg/chnroute6.txt
	$(INSTALL_DATA) ./files/cn-domains.txt     $(1)/etc/warp-wg/cn-domains.txt
	$(INSTALL_DATA) ./files/endpoints.txt      $(1)/etc/warp-wg/endpoints.txt
endef

$(eval $(call BuildPackage,warp-wg))
