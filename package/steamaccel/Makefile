#
# steamaccel —— 路由器侧网络加速套件
#
# 把 PC 版 Watt Toolkit / Steam++ 那套「劫持 + 换上游」在路由器上重做成
# 不需要 MITM 的形态：
#   - 域名 → 上游反代，走 dnsmasq 的 cname/address 改写（客户端证书校验全程正常）
#   - 写死 IP 的规则，靠 steamaccel-probe 并发 TCP 测速选最优
#   - 规则源自官方接口 https://api.steampp.net/accelerator/projectgroups
#
# 不含 HTML 注入 / UA 伪造（那需要本地根证书，路由器上不做）。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=steamaccel
PKG_VERSION:=1.0.0
PKG_RELEASE:=1

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=thisxxx

PKG_BUILD_DIR:=$(BUILD_DIR)/$(PKG_NAME)-$(PKG_VERSION)
PKG_BUILD_PARALLEL:=1

include $(INCLUDE_DIR)/package.mk

define Package/steamaccel
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=Web Servers/Proxies
  TITLE:=Network accelerator (DNS rewrite + IP speed probe)
  DEPENDS:=+dnsmasq +lua +liblua +luci-lib-jsonc +uclient-fetch +libustream-mbedtls
  PKGARCH:=$(ARCH_PACKAGES)
endef

define Package/steamaccel/description
  Router-side reimplementation of the Watt Toolkit accelerator: rewrites
  Steam/community domains to reachable upstream mirrors via dnsmasq, and
  probes candidate IPs over TCP to pick the fastest one. No TLS interception,
  so no root CA needs to be installed on any client device.
endef

define Build/Prepare
	mkdir -p $(PKG_BUILD_DIR)
	$(CP) ./src/probe.c $(PKG_BUILD_DIR)/
endef

define Build/Compile
	$(TARGET_CC) $(TARGET_CFLAGS) $(TARGET_LDFLAGS) -std=gnu99 -O2 -Wall \
		-o $(PKG_BUILD_DIR)/steamaccel-probe $(PKG_BUILD_DIR)/probe.c
	$(STRIP) $(PKG_BUILD_DIR)/steamaccel-probe
endef

define Package/steamaccel/conffiles
/etc/config/steamaccel
endef

define Package/steamaccel/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) $(PKG_BUILD_DIR)/steamaccel-probe $(1)/usr/bin/steamaccel-probe

	$(INSTALL_DIR) $(1)/usr/sbin
	$(INSTALL_BIN) ./files/steamaccel-update $(1)/usr/sbin/steamaccel-update
	$(INSTALL_BIN) ./files/steamaccel-apply $(1)/usr/sbin/steamaccel-apply

	$(INSTALL_DIR) $(1)/usr/lib/steamaccel
	$(INSTALL_DATA) ./files/gen.lua $(1)/usr/lib/steamaccel/gen.lua

	$(INSTALL_DIR) $(1)/usr/share/steamaccel
	$(INSTALL_DATA) ./files/rules.json $(1)/usr/share/steamaccel/rules.json

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/steamaccel.init $(1)/etc/init.d/steamaccel

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/steamaccel.config $(1)/etc/config/steamaccel

	$(INSTALL_DIR) $(1)/etc/hotplug.d/iface
	$(INSTALL_BIN) ./files/90-steamaccel $(1)/etc/hotplug.d/iface/90-steamaccel
endef

$(eval $(call BuildPackage,steamaccel))
