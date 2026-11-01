#!/usr/bin/lua
--
-- steamaccel 规则生成器
--
-- 输入: api.steampp.net/accelerator/projectgroups 返回的 JSON
-- 输出: 按 --mode 生成 dnsmasq 配置 / nginx SNI 映射 / 机器可读清单
--
-- 规则形态（每条）:
--   MatchDomainNames   源域名，';' 分隔，可能带 *. 前缀
--   ForwardDomainNames 上游，域名或 IP
--   Port               上游端口（DNS 层用不上，SNI 分流要用）
--   Items              子规则，递归
--
-- 生成策略:
--   上游是 IP            -> address=/src/ip        （静态，靠 probe 保活）
--   上游是域名 + 精确源  -> cname=src,forward      （让客户端自己解析，保留 CDN 就近）
--   上游是域名 + 通配源  -> address=/base/<解析出的 IP>（dnsmasq 不支持通配 cname）
--
-- 优先用 LuCI 的封装（出错返回 nil 不抛异常），没有就退回裸 cjson
local jsonc
do
    local ok, m = pcall(require, "luci.jsonc")
    if ok and type(m) == "table" and m.parse then
        jsonc = m
    else
        local cjson = require "cjson"
        jsonc = {
            parse = function(s)
                local ok2, r = pcall(cjson.decode, s)
                return ok2 and r or nil
            end,
        }
    end
end

local MODE = "dnsmasq"
local INPUT = nil
local EXTRA = "/etc/steamaccel/extra.tsv"
for i = 1, #arg do
    if arg[i] == "--mode" then
        MODE = arg[i + 1] or "dnsmasq"
    elseif arg[i] == "--extra" then
        EXTRA = arg[i + 1]
    elseif not arg[i]:match("^%-%-") and not (i > 1 and (arg[i - 1] == "--mode" or arg[i - 1] == "--extra")) then
        INPUT = arg[i]
    end
end
if not INPUT then
    io.stderr:write("usage: gen.lua <rules.json> [--mode dnsmasq|nginx|json] [--extra extra.tsv]\n")
    os.exit(2)
end

-- ---------------------------------------------------------------- 第三方通道
--
-- extra.tsv 是 steamaccel-sync 从 UsbEAm / steamcommunity302 同步来的通道，
-- 格式 domain<TAB>ip<TAB>source。它们排在 Watt 规则之前输出：
--   1. 这些源更新更勤（UsbEAm 的 IP 池是人工维护的当前可用节点）
--   2. 官方规则失效时它们往往还活着，是"规则通道先走"的第一道保险
local extra_lines = {}      -- { line=, src=, dom=, ip= }
local extra_domains = {}    -- domain -> true，用于让 Watt 侧避让
local extra_stat = { dom = 0, ip = 0, cname = 0 }

do
    local ef = io.open(EXTRA, "r")
    if ef then
        local emitted = {}
        for line in ef:lines() do
            line = line:gsub("\r", "")
            local d, up, src = line:match("^([^\t]+)\t([^\t]+)\t(.*)$")
            if d and up and d ~= "" then
                local l, ip
                if up:match("^%d+%.%d+%.%d+%.%d+$") then
                    -- 上游是 IP：直接给 A 记录
                    ip = up
                    l = "address=/" .. d .. "/" .. up
                elseif up:match("^[%w][%w%.%-%_]*%.?$") and up:find("%.") then
                    -- 上游是域名（如 302 的 ghapi.steam302.xyz）：cname 让客户端自己解析，
                    -- 保留 CDN 就近；这类上游在探活时会先解析成 IP 再验
                    l = "cname=" .. d .. "," .. up
                end
                if l and not emitted[l] then
                    emitted[l] = true
                    extra_lines[#extra_lines + 1] = { line = l, src = src or "", dom = d, up = up }
                    if ip then
                        extra_stat.ip = extra_stat.ip + 1
                    else
                        extra_stat.cname = extra_stat.cname + 1
                    end
                end
                if not extra_domains[d] then
                    extra_domains[d] = true
                    extra_stat.dom = extra_stat.dom + 1
                end
            end
        end
        ef:close()
    end
end

local f = io.open(INPUT, "r")
if not f then
    io.stderr:write("cannot open " .. INPUT .. "\n")
    os.exit(1)
end
local raw = f:read("*a")
f:close()

local doc = jsonc.parse(raw)
if not doc then
    io.stderr:write("json parse failed\n")
    os.exit(1)
end

-- 只取 🦓 这棵（正式规则树）；🦄 是版本号，🐴 是附加数据
local tree = doc["\240\159\166\147"] or doc["🦓"]
if type(tree) ~= "table" then
    io.stderr:write("no rule tree found\n")
    os.exit(1)
end

local function trim(s)
    return (s:gsub("^%s+", ""):gsub("%s+$", ""))
end

local function split_semi(s)
    local out = {}
    if type(s) ~= "string" then return out end
    for piece in s:gmatch("[^;]+") do
        piece = trim(piece)
        if piece ~= "" then out[#out + 1] = piece end
    end
    return out
end

-- 域名合法性：只允许字母数字连字符点，且必须有点
local function valid_host(h)
    if type(h) ~= "string" or #h < 3 or #h > 253 then return false end
    if not h:find("%.") then return false end
    return h:match("^[%w][%w%.%-%_]*%.?$") ~= nil
end

local function is_ip(s)
    if type(s) ~= "string" then return false end
    if s:match("^%d+%.%d+%.%d+%.%d+$") then return true end
    return s:find(":", 1, true) ~= nil
end

-- 上游可能带端口 "host:8080"
local function split_port(s)
    if type(s) ~= "string" then return nil, nil end
    local h, p = s:match("^([^:]+):(%d+)$")
    if h then return h, tonumber(p) end
    return s, nil
end

local resolve_cache = {}
local function resolve4(host)
    if resolve_cache[host] ~= nil then return resolve_cache[host] end
    local ip = nil
    local p = io.popen("resolveip -4 " .. host .. " 2>/dev/null")
    if p then
        local line = p:read("*l")
        p:close()
        if line and line:match("^%d+%.%d+%.%d+%.%d+$") then ip = line end
    end
    resolve_cache[host] = ip or false
    return ip
end

local rules = {}
local seen = {}

local function collect(items)
    if type(items) ~= "table" then return end
    for _, it in ipairs(items) do
        if type(it) == "table" then
            local srcs = split_semi(it.MatchDomainNames)
            local fwd = it.ForwardDomainNames
            local port = it.Port or 443
            local fwd_host, fwd_port = split_port(fwd)
            if fwd_port then port = fwd_port end

            if fwd_host and valid_host(fwd_host) and #srcs > 0 then
                for _, src in ipairs(srcs) do
                    local wildcard = src:sub(1, 2) == "*."
                    local base = wildcard and src:sub(3) or src
                    if valid_host(base) then
                        local key = base .. "|" .. fwd_host .. "|" .. tostring(port)
                        if not seen[key] then
                            seen[key] = true
                            rules[#rules + 1] = {
                                src = base,
                                wildcard = wildcard,
                                fwd = fwd_host,
                                fwd_is_ip = is_ip(fwd_host),
                                port = port,
                                name = it.Name or "",
                                group = "",
                            }
                        end
                    end
                end
            end
            if it.Items then collect(it.Items) end
        end
    end
end

for _, grp in ipairs(tree) do
    if type(grp) == "table" then
        local before = #rules
        collect(grp.Items)
        for i = before + 1, #rules do rules[i].group = grp.Name or "" end
    end
end

-- ---------------------------------------------------------------- 输出

local stat = { total = #rules, cname = 0, address_ip = 0, address_resolved = 0, unresolved = 0, skipped = 0 }

if MODE == "dnsmasq" then
    print("# steamaccel: generated from api.steampp.net")
    print("# rules: " .. #rules .. "  do not edit, regenerated on update")

    -- 第一段：同步来的第三方通道，排最前
    if #extra_lines > 0 then
        print("")
        print("# --- synced channels (priority) " .. extra_stat.dom .. " domains / " ..
              extra_stat.ip .. " ip / " .. extra_stat.cname .. " cname ---")
        for _, e in ipairs(extra_lines) do
            print(e.line)
        end
        print("# --- end synced channels ---")
    end

    -- 第二段：Watt 官方规则
    local emitted = {}
    for _, r in ipairs(rules) do
        -- 被同步通道精确覆盖的域名，Watt 侧一律避让。
        --
        -- 不叠加的原因：dnsmasq 里同域名的 cname 与 address 是两张表，
        -- 谁生效取决于版本和查询路径，无法预测。叠加会让"同步来的优先"变成碰运气。
        --
        -- 后备不靠这里，靠 steamaccel-apply 的探活：
        -- 同步通道的 IP/上游全挂 -> 该域名的配置行被整条剔除 -> 走正常解析
        -- （隧道开着就走隧道），降级路径是通的。
        local line = nil
        if extra_domains[r.src] then
            stat.skipped = stat.skipped + 1
        elseif r.fwd_is_ip then
            line = "address=/" .. r.src .. "/" .. r.fwd
            stat.address_ip = stat.address_ip + 1
        elseif not r.wildcard then
            line = "cname=" .. r.src .. "," .. r.fwd
            stat.cname = stat.cname + 1
        else
            local ip = resolve4(r.fwd)
            if ip then
                line = "address=/" .. r.src .. "/" .. ip
                stat.address_resolved = stat.address_resolved + 1
            else
                stat.unresolved = stat.unresolved + 1
            end
        end
        if line and not emitted[line] then
            emitted[line] = true
            print(line)
        end
    end

elseif MODE == "nginx" then
    -- stream + ssl_preread 的 map 片段：只读 ClientHello 的 SNI，不做 TLS 终结
    print("# steamaccel: SNI routing map (no TLS termination)")
    local emitted = {}

    -- 同步通道同样优先
    for _, e in ipairs(extra_lines) do
        if e.up and e.up ~= "" then
            local line = "    " .. e.dom .. "  " .. e.up .. ":443;"
            if not emitted[line] then
                emitted[line] = true
                print(line)
            end
        end
    end

    for _, r in ipairs(rules) do
        if not r.fwd_is_ip then
            local target = r.fwd .. ":" .. r.port
            local line = "    " .. r.src .. "  " .. target .. ";"
            if not emitted[line] then
                emitted[line] = true
                print(line)
            end
        end
    end
    print("    # --- end steamaccel ---")

elseif MODE == "json" then
    local out = { total = #rules, items = {} }
    for _, r in ipairs(rules) do
        out.items[#out.items + 1] = {
            src = r.src, wildcard = r.wildcard, fwd = r.fwd,
            port = r.port, name = r.name, group = r.group,
        }
    end
    print(jsonc.stringify(out))
end

if MODE == "dnsmasq" then
    io.stderr:write(string.format(
        "steamaccel: extra=%d dom/%d ip/%d cname  watt=%d (cname=%d addr=%d resolved=%d unresolved=%d skipped=%d)\n",
        extra_stat.dom, extra_stat.ip, extra_stat.cname, stat.total,
        stat.cname, stat.address_ip, stat.address_resolved, stat.unresolved, stat.skipped))
end
