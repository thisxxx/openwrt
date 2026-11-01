#
# easytier —— EasyTier 组网（lite 构建）
#
# 二进制来源: https://github.com/thisxxx/EasyTier 的 lite 构建
#   easytier-lite-linux-mipsel.zip  →  upx -d  →  6,698,364 B 的静态 ELF
#
# 不用 UPX 压缩版（1,769,144 B）: 它启动时要把整块解压到匿名内存，
# 128MB 无 swap 的机器上等于把压力从中途搬到开机那一刻，得不偿失。
#
include $(TOPDIR)/rules.mk

PKG_NAME:=easytier
PKG_VERSION:=0.2.0-lite
PKG_RELEASE:=1

PKG_LICENSE:=Apache-2.0
PKG_MAINTAINER:=thisxxx

include $(INCLUDE_DIR)/package.mk

define Package/easytier
  SECTION:=net
  CATEGORY:=Network
  SUBMENU:=VPN
  TITLE:=EasyTier mesh VPN (static lite build)
  URL:=https://github.com/EasyTier/EasyTier
  DEPENDS:=+kmod-tun
endef

define Package/easytier/description
  EasyTier 是一个去中心化的组网工具，用于把多台设备组成一个虚拟局域网。
  本包使用静态链接的 lite 构建，无需额外运行时库。
endef

define Package/easytier/conffiles
/etc/config/easytier
endef

define Build/Prepare
	@if [ ! -f "$(CURDIR)/files/easytier-core" ]; then \
		echo "ERROR: 缺少 files/easytier-core"; \
		echo "  先执行: gh release download lite-v0.2.0 -R thisxxx/EasyTier -p 'easytier-lite-linux-mipsel.zip'"; \
		echo "  解压并 upx -d 后放到 package/easytier/files/easytier-core"; \
		exit 1; \
	fi
	@sz=$$(wc -c < "$(CURDIR)/files/easytier-core"); \
	if [ "$$sz" = "1769144" ]; then \
		echo "ERROR: 放进来的是 UPX 压缩版，请先 upx -d"; exit 1; \
	fi
	mkdir -p $(PKG_BUILD_DIR)
endef

define Build/Compile
	true
endef

define Package/easytier/install
	$(INSTALL_DIR) $(1)/usr/bin
	$(INSTALL_BIN) ./files/easytier-core $(1)/usr/bin/easytier-core

	$(INSTALL_DIR) $(1)/etc/init.d
	$(INSTALL_BIN) ./files/easytier.init $(1)/etc/init.d/easytier

	$(INSTALL_DIR) $(1)/etc/config
	$(INSTALL_CONF) ./files/easytier.config $(1)/etc/config/easytier

	$(INSTALL_DIR) $(1)/etc/uci-defaults
	$(INSTALL_BIN) ./files/99-easytier $(1)/etc/uci-defaults/99-easytier
endef

$(eval $(call BuildPackage,easytier))
