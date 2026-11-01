'use strict';
'require view';
'require form';
'require uci';
'require fs';
'require ui';

function fmtBytes(n) {
	n = Number(n) || 0;
	if (n >= 1048576) return (n / 1048576).toFixed(1) + ' MiB';
	if (n >= 1024) return (n / 1024).toFixed(1) + ' KiB';
	return n + ' B';
}

function fmtAge(s) {
	s = Number(s);
	if (s < 0) return _('从未成功');
	if (s < 60) return s + _(' 秒前');
	if (s < 3600) return Math.floor(s / 60) + _(' 分钟前');
	return Math.floor(s / 3600) + _(' 小时前');
}

return view.extend({
	load: function () {
		return Promise.all([
			uci.load('warp-wg'),
			L.resolveDefault(fs.exec('/usr/bin/warp-status', ['--json']), { stdout: '{}' })
		]);
	},

	parseStatus: function (r) {
		try { return JSON.parse((r && r.stdout) || '{}'); } catch (e) { return {}; }
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

		var up = Number(st.up) === 1;
		var handshake = Number(st.handshake_age);
		var hsCls = handshake < 0 ? 'text-danger' : (handshake > 180 ? 'text-warning' : 'text-success');

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('隧道状态')),
			mk(_('接口'), (st.iface || 'warp0') + (up ? _('（已建立）') : _('（未建立）')),
				up ? 'text-success' : 'text-danger'),
			mk(_('握手'), fmtAge(handshake), hsCls),
			mk(_('隧道内地址'), st.address || '-'),
			mk(_('endpoint'), st.endpoint || '-'),
			mk(_('流量'), _('收 ') + fmtBytes(st.rx) + ' / ' + _('发 ') + fmtBytes(st.tx)),
			mk(_('分流'), Number(st.route_on) === 1
				? (st.split === 'china'
					? _('已启用（国内直连，国内段 ') + (st.cn_rules || 0) + _(' 条）')
					: _('已启用（全局走隧道）'))
				: _('未启用'), Number(st.route_on) === 1 ? 'text-success' : '')
		]);
	},

	render: function (data) {
		var st = this.parseStatus(data[1]);
		var self = this;

		var m = new form.Map('warp-wg', _('出口（WireGuard）'),
			_('用内核 WireGuard 做出口：国内 IP 直连，其余全部走隧道，' +
			  '因此不依赖任何域名清单，Google / YouTube / Telegram 这类站点自动覆盖。' +
			  'WARP 只是零成本兜底，任何标准 WireGuard 服务端都能填进来替换。'));

		var s = m.section(form.NamedSection, 'cfg', 'warp', _('隧道'));
		s.anonymous = true;

		s.option(form.Flag, 'enabled', _('启用隧道'),
			_('关闭后立即拆除隧道与分流规则，整网回到直连'));

		var o = s.option(form.ListValue, 'split_mode', _('分流模式'));
		o.value('china', _('国内直连，其余走隧道（推荐）'));
		o.value('global', _('全部走隧道'));
		o.default = 'china';

		s.option(form.Value, 'endpoint', _('endpoint'),
			_('格式 IP:端口 或 域名:端口。连不上就点下面的「优选 endpoint」'));

		s.option(form.Value, 'mtu', _('MTU'), _('默认 1280，链路不好可降到 1200'))
			.datatype = 'range(576,1500)';

		s.option(form.Value, 'dns', _('隧道内 DNS'),
			_('境外域名用它解析，必须走隧道才不会被污染'));

		s.option(form.Value, 'dns_cn', _('国内 DNS'),
			_('国内域名用它解析，拿到就近 CDN'));

		s.option(form.Flag, 'auto_scan', _('启动时自动优选 endpoint'),
			_('隧道起来后自动跑一次 warp-scan，多等十几秒'));

		s.option(form.Value, 'watchdog_timeout', _('看门狗阈值（秒）'),
			_('握手超过这个时间没更新就自动重连。0 表示关闭'))
			.datatype = 'uinteger';

		var adv = m.section(form.NamedSection, 'cfg', 'warp', _('高级：手动导入'));
		adv.anonymous = true;

		adv.option(form.Value, 'private_key', _('本机私钥'),
			_('留空则点下面的「注册 WARP」自动生成')).password = true;

		adv.option(form.Value, 'peer_public_key', _('对端公钥'), '');
		adv.option(form.Value, 'address4', _('隧道内 IPv4'), '');

		var statusNode = this.renderStatus(st);

		var runBtn = function (label, cmd, args, desc) {
			return E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'style': 'margin-right:8px',
				'click': ui.createHandlerFn(self, function () {
					return fs.exec(cmd, args || [])
						.then(function (r) {
							var out = ((r.stdout || '') + (r.stderr || '')).trim();
							ui.addNotification(null, E('pre', {
								'style': 'white-space:pre-wrap;max-height:260px;overflow:auto'
							}, desc + '\n' + (out || _('（无输出）'))),
								r.code === 0 ? 'info' : 'danger');
							return fs.exec('/usr/bin/warp-status', ['--json']);
						})
						.then(function (r2) {
							statusNode.replaceWith(self.renderStatus(self.parseStatus(r2)));
						})
						.catch(function (e) {
							ui.addNotification(null, E('p', {}, _('执行失败：') + e), 'danger');
						});
				})
			}, label);
		};

		var actions = E('div', { 'class': 'cbi-page-actions' }, [
			runBtn(_('注册 WARP'),
				'/usr/bin/warp-register', [], _('正在注册 Cloudflare WARP 账号…')),
			runBtn(_('优选 endpoint'),
				'/usr/bin/warp-scan', [], _('正在逐个探测 endpoint…')),
			runBtn(_('重启隧道'),
				'/etc/init.d/warp-wg', ['restart'], _('正在重启隧道…'))
		]);

		return m.render().then(function (node) {
			return E('div', {}, [
				E('div', { 'class': 'cbi-section' }, [
					E('p', { 'class': 'cbi-section-descr' },
						_('第一次使用：点「注册 WARP」→ 等提示成功 → 点「优选 endpoint」→ ' +
						  '保存并应用。注册只需要一次。'))
				]),
				node,
				statusNode,
				actions
			]);
		});
	}
});
