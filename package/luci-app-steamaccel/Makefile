include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI 网络加速（Steam / 社区域名优化）
LUCI_DESCRIPTION:=管理 steamaccel：规则来源、更新间隔、探活、SNI 分流
LUCI_DEPENDS:=+steamaccel +luci-base
LUCI_PKGARCH:=all

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=thisxxx

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
