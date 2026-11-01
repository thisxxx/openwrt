include $(TOPDIR)/rules.mk

LUCI_TITLE:=LuCI 网络加速（规则加速 + WireGuard 出口）
LUCI_DESCRIPTION:=规则加速（Steam 等域名改写）与 WireGuard/WARP 出口、国内直连分流
LUCI_DEPENDS:=+steamaccel +warp-wg +luci-base
LUCI_PKGARCH:=all

PKG_LICENSE:=GPL-2.0-only
PKG_MAINTAINER:=thisxxx

include $(TOPDIR)/feeds/luci/luci.mk

# call BuildPackage - OpenWrt buildroot signature
