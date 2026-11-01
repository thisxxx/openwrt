'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';
'require poll';

function fmtNum(n) {
	n = Number(n) || 0;
	return n.toString();
}

function fmtTime(ts) {
	ts = Number(ts) || 0;
	if (ts <= 0) return _('从未');
	var d = new Date(ts * 1000);
	var p = function (x) { return (x < 10 ? '0' : '') + x; };
	return d.getFullYear() + '-' + p(d.getMonth() + 1) + '-' + p(d.getDate()) + ' ' +
		p(d.getHours()) + ':' + p(d.getMinutes());
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('steamaccel'),
			L.resolveDefault(fs.read('/tmp/steamaccel/status.json'), '{}')
		]);
	},

	parseStatus: function (raw) {
		try { return JSON.parse(raw || '{}'); } catch (e) { return {}; }
	},

	renderStatus: function (st) {
		var mk = function (label, value, cls) {
			return E('div', { 'class': 'cbi-value' }, [
				E('label', { 'class': 'cbi-value-title' }, label),
				E('div', { 'class': 'cbi-value-field' }, [
					E('span', { 'class': cls || '' }, value)
				])
			]);
		};

		var dead = Number(st.dead) || 0;
		var exTotal = Number(st.extra_total) || 0;
		var exLive = Number(st.extra_live) || 0;
		var lost = exTotal > 0 ? exTotal - exLive : 0;

		var rows = [
			mk(_('生效规则'), fmtNum(st.total) + ' ' + _('条')),
			mk(_('其中 cname 重写'), fmtNum(st.cname) + ' ' + _('条')),
			mk(_('其中直指 IP'), fmtNum(st.address) + ' ' + _('条')),
			mk(_('探活失败（已回退正常解析）'), fmtNum(dead) + ' ' + _('条'),
				dead > 0 ? 'text-danger' : ''),
			mk(_('上次更新'), fmtTime(st.updated)),
			mk(_('数据来源'), st.source || '-')
		];

		if (exTotal > 0) {
			rows.push(E('h3', { style: 'margin-top:1.5em' }, _('第三方通道（优先）')));
			rows.push(mk(_('同步通道条目'), fmtNum(exTotal) + ' ' + _('条')));
			rows.push(mk(_('实际生效'), fmtNum(exLive) + ' ' + _('条'),
				exLive === 0 ? 'text-danger' : ''));
			if (lost > 0)
				rows.push(mk(_('探活剔除'), fmtNum(lost) + ' ' + _('条'), 'text-warning'));
			rows.push(mk(_('覆盖域名'), fmtNum(st.extra_domains) + ' ' + _('个')));
			rows.push(mk(_('不同上游'), fmtNum(st.extra_upstreams) + ' ' + _('个')));
			rows.push(mk(_('来源'), st.extra_sources || '-'));
			rows.push(mk(_('上次同步'), fmtTime(st.extra_updated)));
		}

		if (st.bypass)
			rows.push(mk(_('直连白名单 IP'), fmtNum(st.bypass) + ' ' + _('个'),
				_('这些 IP 由规则通道优先使用，不会被隧道抢走')));

		return E('div', { 'class': 'cbi-section' }, [E('h3', {}, _('当前状态'))].concat(rows));
	},

	render: function (data) {
		var st = this.parseStatus(data[1]);
		var self = this;

		var m = new form.Map('steamaccel', _('网络加速'),
			_('把 Steam 商店/社区等域名指向可用的上游镜像。只改 DNS，不解密 TLS，' +
			  '任何客户端都不需要安装证书。'));

		var s = m.section(form.NamedSection, 'main', 'steamaccel', _('基本设置'));
		s.anonymous = true;

		s.option(form.Flag, 'enabled', _('启用'),
			_('关闭后立即移除所有改写规则并恢复正常解析'));

		s.option(form.Value, 'api', _('规则接口'),
			_('官方接口，POST 空 JSON 即返回全量规则，无需鉴权'));

		s.option(form.Value, 'mirror', _('备用镜像'),
			_('官方接口不通时改从这个地址 GET 规则文件，留空则不用'));

		var o = s.option(form.ListValue, 'update_interval', _('同步间隔'),
			_('每次同步做三件事：拉官方规则 → 拉第三方通道 → 合并生效'));
		o.value('0', _('仅开机时'));
		o.value('6', _('每 6 小时'));
		o.value('12', _('每 12 小时'));
		o.value('24', _('每 24 小时'));
		o.value('72', _('每 3 天'));
		o.default = '24';

		// ---- 第三方通道 ----
		var x = m.section(form.NamedSection, 'main', 'steamaccel', _('第三方通道同步'),
			_('这些老牌工具各自维护节点，更新比官方勤，官方规则失效时往往还活着。' +
			  '同步来的通道排在官方规则之前生效。'));

		x.anonymous = true;

		x.option(form.Flag, 'sync_usbeam', _('UsbEAm'),
			_('dogfight360/UsbEAm 的规则库：[Reverse proxy] 段含 4 个通用 SNI 反代 IP，' +
			  '以及各游戏平台/CDN 的 443 上游。'));

		x.option(form.Flag, 'sync_302', _('Steamcommunity 302'),
			_('从发布包的 Caddyfile 里读出上游：str001-003 与 gh*.steam302.xyz 共 14 个。'));

		x.option(form.Flag, 'sync_ghproxy', _('GitHub 镜像清单'),
			_('weekoo2025/ghproxy 的 mirrors.json。这是 URL 前缀镜像（不是 DNS 通道），' +
			  '只写进清单备用，不参与域名改写。'));

		var t = m.section(form.NamedSection, 'main', 'steamaccel', _('探活与分流'));
		t.anonymous = true;

		t.option(form.Flag, 'healthcheck', _('上游探活'),
			_('对写死 IP 的规则做 TCP 探测，连不通的自动退回正常 DNS 解析。宁可慢，不要死。'));

		t.option(form.Value, 'probe_timeout', _('探测超时'),
			_('毫秒。默认 2000')).datatype = 'range(500,10000)';

		t.option(form.Flag, 'sni', _('SNI 分流（需要 nginx）'),
			_('在 443 上按 ClientHello 里的 SNI 把连接导到不同上游，不做 TLS 终结。' +
			  '未安装 nginx 时此项无效。')).rmempty = false;

		var statusBox = E('div', {});
		statusBox.appendChild(this.renderStatus(st));

		var refresh = function () {
			return fs.read('/tmp/steamaccel/status.json').then(function (raw) {
				var node = self.renderStatus(self.parseStatus(raw));
				while (statusBox.firstChild)
					statusBox.removeChild(statusBox.firstChild);
				statusBox.appendChild(node);
			});
		};

		var mkBtn = function (label, cmd, args, cls) {
			return E('button', {
				'class': 'btn cbi-button ' + (cls || 'cbi-button-action'),
				'style': 'margin-right:8px',
				'click': ui.createHandlerFn(self, function () {
					return fs.exec(cmd, args)
						.then(function (r) {
							ui.addNotification(null,
								E('p', {}, label + _(' 已执行，返回码 ') + r.code),
								r.code === 0 ? 'info' : 'warning');
							return refresh();
						})
						.catch(function (e) {
							ui.addNotification(null, E('p', {}, label + _(' 失败：') + e), 'danger');
						});
				})
			}, label);
		};

		var updateNode = E('div', { 'class': 'cbi-page-actions' }, [
			mkBtn(_('同步规则与通道'), '/usr/sbin/steamaccel-update', ['--force']),
			mkBtn(_('仅同步通道'), '/usr/sbin/steamaccel-sync', [], 'cbi-button-action'),
			E('button', {
				'class': 'btn cbi-button cbi-button-reset',
				'click': ui.createHandlerFn(self, function () {
					return fs.exec('/usr/sbin/steamaccel-apply', []).then(function () {
						ui.addNotification(null, E('p', {}, _('已重新应用')), 'info');
						return refresh();
					});
				})
			}, _('重新应用'))
		]);

		return m.render().then(function (node) {
			return E('div', {}, [node, statusBox, updateNode]);
		});
	},

	btnBusy: function (busy) { /* 占位：按钮防抖留给 LuCI 自身处理 */ },

	handleSaveApply: null,
	handleSave: null
});
