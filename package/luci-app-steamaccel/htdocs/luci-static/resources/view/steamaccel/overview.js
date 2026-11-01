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

		return E('div', { 'class': 'cbi-section' }, [
			E('h3', {}, _('当前状态')),
			mk(_('生效规则'), fmtNum(st.total) + ' ' + _('条')),
			mk(_('其中 cname 重写'), fmtNum(st.cname) + ' ' + _('条')),
			mk(_('其中直指 IP'), fmtNum(st.address) + ' ' + _('条')),
			mk(_('探活失败（已回退正常解析）'), fmtNum(dead) + ' ' + _('条'),
				dead > 0 ? 'text-danger' : ''),
			mk(_('上次更新'), fmtTime(st.updated)),
			mk(_('数据来源'), st.source || '-')
		]);
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

		var o = s.option(form.ListValue, 'update_interval', _('自动更新'),
			_('规则本身变化很慢，一天一次足够'));
		o.value('0', _('仅开机时'));
		o.value('6', _('每 6 小时'));
		o.value('12', _('每 12 小时'));
		o.value('24', _('每 24 小时'));
		o.value('72', _('每 3 天'));
		o.default = '24';

		var t = m.section(form.NamedSection, 'main', 'steamaccel', _('探活与分流'));
		t.anonymous = true;

		t.option(form.Flag, 'healthcheck', _('上游探活'),
			_('对写死 IP 的规则做 TCP 探测，连不通的自动退回正常 DNS 解析。宁可慢，不要死。'));

		t.option(form.Value, 'probe_timeout', _('探测超时'),
			_('毫秒。默认 2000')).datatype = 'range(500,10000)';

		t.option(form.Flag, 'sni', _('SNI 分流（需要 nginx）'),
			_('在 443 上按 ClientHello 里的 SNI 把连接导到不同上游，不做 TLS 终结。' +
			  '未安装 nginx 时此项无效。')).rmempty = false;

		var statusNode = this.renderStatus(st);
		var updateNode = E('div', { 'class': 'cbi-page-actions' }, [
			E('button', {
				'class': 'btn cbi-button cbi-button-action',
				'click': ui.createHandlerFn(this, function () {
					this.btnBusy(true);
					return fs.exec('/usr/sbin/steamaccel-update', ['--force'])
						.then(function (r) {
							ui.addNotification(null,
								E('p', {}, _('更新已执行，返回码 ') + r.code), 'info');
							return fs.read('/tmp/steamaccel/status.json');
						})
						.then(function (raw) {
							statusNode.replaceWith(self.renderStatus(self.parseStatus(raw)));
						})
						.catch(function (e) {
							ui.addNotification(null, E('p', {}, _('更新失败：') + e), 'danger');
						});
				})
			}, _('立即更新规则'))
		]);

		return m.render().then(function (node) {
			return E('div', {}, [node, statusNode, updateNode]);
		});
	},

	btnBusy: function (busy) { /* 占位：按钮防抖留给 LuCI 自身处理 */ },

	handleSaveApply: null,
	handleSave: null
});
