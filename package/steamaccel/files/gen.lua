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
for i = 1, #arg do
    if arg[i] == "--mode" then
        MODE = arg[i + 1] or "dnsmasq"
    elseif not arg[i]:match("^%-%-") and not (i > 1 and arg[i - 1] == "--mode") then
        INPUT = arg[i]
    end
end
if not INPUT then
    io.stderr:write("usage: gen.lua <rules.json> [--mode dnsmasq|nginx|json]\n")
    os.exit(2)
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

local stat = { total = #rules, cname = 0, address_ip = 0, address_resolved = 0, unresolved = 0 }

if MODE == "dnsmasq" then
    print("# steamaccel: generated from api.steampp.net")
    print("# rules: " .. #rules .. "  do not edit, regenerated on update")
    local emitted = {}
    for _, r in ipairs(rules) do
        local line = nil
        if r.fwd_is_ip then
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
        "steamaccel: total=%d cname=%d address(ip)=%d address(resolved)=%d unresolved=%d\n",
        stat.total, stat.cname, stat.address_ip, stat.address_resolved, stat.unresolved))
end
