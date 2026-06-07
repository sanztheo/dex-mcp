# DEX-MCP Luau Bridge Implementation Plan

> **For agentic workers:** REQUIRED SUB-SKILL: Use superpowers:subagent-driven-development (recommended) or superpowers:executing-plans to implement this plan task-by-task. Steps use checkbox (`- [ ]`) syntax for tracking.

**Goal:** Build the Luau bridge that runs inside a Roblox executor, connects to the dex-mcp server over WebSocket, and answers the frozen §4 RPC protocol — making the already-built MCP server work against a real Roblox client.

**Architecture:** Two pure, lune-testable Luau factory modules (`codec.luau`, `core.luau`) take an injected `env` (real Roblox globals in production, stubs in tests). A thin `dex-bridge.luau` glue assembles the env, wires the WebSocket connect/reconnect supervisor, and bootstraps. The Node server gains a `GET /bridge` HTTP route that assembles the three Luau files, injects the per-run port+token, and serves a one-line `loadstring(game:HttpGet(...))()` payload.

**Tech Stack:** Luau (executor runtime), [lune](https://lune-ui.dev) (Luau CLI runtime for unit tests), TypeScript/Node (server route), `ws`, `vitest`.

**Frozen contract:** The bridge MUST byte-match `test/mock-bridge.ts` `handle()` and protocol §4 — the 34 server tests run against the mock, never against this Luau, so the mock IS the contract. Notably: `getChildren` and `search` return **bare `Node[]` arrays** (no `{nodes,truncated}` wrapper); `getByPath` returns a **bare node**; tagged `Instance` uses field **`class`** (not `className`); error replies carry an exact string message.

**Companion:** server plan `docs/superpowers/plans/2026-06-07-dex-mcp-server.md`; design spec `docs/superpowers/specs/2026-06-07-dex-mcp-design.md` (§4 protocol, §6 codec).

---

## Decisions baked in (resolved during planning)

- **Launch UX:** HTTP loader. Server serves the assembled+token-injected bridge on its existing port; user runs `loadstring(game:HttpGet("http://127.0.0.1:<port>/bridge"))()`. The `/bridge` route is localhost-only and unauthenticated (bootstrap); the WebSocket still requires the token.
- **Codec testing:** install `lune`; codec + core get real lune unit tests, plus a Node/vitest contract test validating canonical tagged shapes against `RobloxValueSchema`.
- **Single source of truth:** `codec.luau` and `core.luau` are never committed pre-concatenated. The server assembles them at serve time.
- **getProperties no-dump fallback:** prefer the executor global `getproperties(inst)` when present (richer); else a curated per-class list walked by `IsA`.
- **Remote spy:** buffer-and-dump only (the server does not consume unsolicited events in v1); capability-gated hard error when the executor lacks the hooks; the spied remote's path is resolved at **dump time** (outside the `__namecall` hook) to avoid re-entrant recursion.
- **Truncation/cap (review Issues 2/3):** OUT OF SCOPE — fixing them changes the frozen contract (bare arrays) and would break the 34 server tests. Tracked as a future coordinated server+bridge+tests change.

---

## File Structure

| File | Responsibility |
|---|---|
| `bridge/codec.luau` | `makeCodec(env)` → `{ encode(v, encodeInstance), decode(v, valueType, current, resolve), finite }`. Pure; mirrors `TaggedValueSchema` |
| `bridge/core.luau` | `makeCore(env)` → ref tables, `dotPath`, `buildNode`, all RPC handlers, `dispatch(raw)→replyString`. Pure (env-injected) |
| `bridge/dex-bridge.luau` | Glue: build `env` from real globals, instantiate codec+core, WebSocket connect/reconnect supervisor, bootstrap. Has injection markers |
| `bridge/test/stubs.luau` | `makeEnv()` — fake Roblox globals (typeof, datatypes, JSON via lune serde, a fake DataModel tree) + `deepEqual`/`assertEq` helpers |
| `bridge/test/codec.test.luau` | lune unit tests for the codec |
| `bridge/test/core.test.luau` | lune unit tests for ref/node/handlers/dispatch |
| `src/bridge-hub/bridge-loader.ts` | `assembleBridge(port, token)` — reads the 3 Luau files, inlines codec+core, substitutes port/token |
| `src/bridge-hub/ws-server.ts` | **modified** — own an `http.Server`, share it with the WS server, add `GET /bridge` |
| `src/index.ts` | **modified** — print the one-line loader instruction |
| `test/bridge-loader.test.ts`, `test/bridge-route.test.ts`, `test/bridge-codec-contract.test.ts` | vitest |

---

## Task 0: Toolchain + lune test harness

**Files:**
- Create: `bridge/test/stubs.luau`, `bridge/test/run-tests.luau`
- Modify: `package.json`

- [ ] **Step 1: Install lune and verify**

Install via rokit (recommended) or a release binary. Try, in order:
```bash
# Option A: rokit (https://github.com/rojo-rbx/rokit) — cross-platform toolchain manager
rokit add lune-org/lune && rokit install
# Option B: cargo
cargo install lune
# Option C: download the lune release binary for your OS and put it on PATH
```
Verify: `lune --version`
Expected: prints a version (e.g. `lune 0.8.x`). If all options fail, report BLOCKED — the codec/core tests cannot run without it.

- [ ] **Step 2: Add npm scripts to `package.json`**

Add to the `scripts` block (keep existing scripts):
```json
    "test:bridge": "lune run bridge/test/run-tests.luau",
    "test:all": "npm run test && npm run test:bridge"
```

> **Which tasks need lune:** Tasks 1, 2, 4, 5, 6, 7 run `lune` (local + CI with the lune install step). Tasks 3, 9, 10, 11 are plain `vitest` (CI-enforceable without lune — Task 3 is the wire-compat proof the CI can always run). If a runner lacks lune, those vitest tasks still validate the contract from the TS side.

- [ ] **Step 3: Create `bridge/test/stubs.luau` (fake Roblox env + assert helpers)**

```lua
--!strict
-- Test-only fakes so codec.luau / core.luau run under lune (no Roblox runtime).
-- typeof(v) recognizes our fake datatypes via a __type marker.
local serde = require("@lune/serde")

local Stubs = {}

-- ---- deep equality + assertions ----------------------------------------
local function deepEqual(a: any, b: any): boolean
	if a == b then return true end  -- identity shortcut: same reference, and breaks cyclic Instance trees
	if type(a) ~= type(b) then return false end
	if type(a) ~= "table" then return a == b end
	for k, v in pairs(a) do if not deepEqual(v, b[k]) then return false end end
	for k in pairs(b) do if a[k] == nil then return false end end
	return true
end
Stubs.deepEqual = deepEqual

function Stubs.assertEq(actual: any, expected: any, msg: string?)
	if not deepEqual(actual, expected) then
		error(("assertEq failed%s\n  expected: %s\n  actual:   %s"):format(
			msg and (" ("..msg..")") or "",
			serde.encode("json", expected),
			serde.encode("json", actual)), 2)
	end
end

-- ---- fake datatypes ----------------------------------------------------
local function tagged(typeName: string, fields: {[string]: any})
	fields.__type = typeName
	return fields
end

local Vector3 = { new = function(x, y, z) return tagged("Vector3", {X=x, Y=y, Z=z}) end }
local Vector2 = { new = function(x, y) return tagged("Vector2", {X=x, Y=y}) end }
local Color3 = { new = function(r, g, b) return tagged("Color3", {R=r, G=g, B=b}) end }
local BrickColor = { new = function(name) return tagged("BrickColor", {Name=name}) end }
local UDim = { new = function(s, o) return tagged("UDim", {Scale=s, Offset=o}) end }
local UDim2 = { new = function(xs, xo, ys, yo)
	return tagged("UDim2", {X=tagged("UDim",{Scale=xs,Offset=xo}), Y=tagged("UDim",{Scale=ys,Offset=yo})})
end }
local CFrame = { new = function(...)
	local c = {...}
	local self = tagged("CFrame", {_c=c})
	function self.GetComponents() return table.unpack(c) end
	return self
end }

-- Enum proxy: Enum.Material.Plastic -> EnumItem; tostring(Enum.Material) -> "Material".
-- proxy is forward-declared so each EnumItem can back-link EnumType=proxy (the codec
-- reads tostring(item.EnumType) -> "Material"). Proxies are cached so FromValue finds items.
local function enumType(name)
	local items = {}
	local proxy
	proxy = setmetatable({}, {
		__index = function(_, itemName)
			if itemName == "FromValue" then
				return function(_, value)
					for _, it in items do if it.Value == value then return it end end
					return nil
				end
			end
			local it = items[itemName]
			if not it then
				it = tagged("EnumItem", {Name=itemName, Value=#items, EnumType=proxy})
				items[itemName] = it
			end
			return it
		end,
		__tostring = function() return name end,  -- tostring(Enum.Material) == "Material"
	})
	return proxy
end
local Enum = setmetatable({ _cache = {} }, { __index = function(self, enumName)
	local cache = rawget(self, "_cache")
	cache[enumName] = cache[enumName] or enumType(enumName)
	return cache[enumName]
end })

Stubs.datatypes = {
	Vector3 = Vector3, Vector2 = Vector2, Color3 = Color3, BrickColor = BrickColor,
	UDim = UDim, UDim2 = UDim2, CFrame = CFrame, Enum = Enum,
	-- NumberSequence/ColorSequence stubbed minimally (keypoints are z.any() in the schema)
	NumberSequence = { new = function(kp) return tagged("NumberSequence", {Keypoints=kp}) end },
	ColorSequence = { new = function(kp) return tagged("ColorSequence", {Keypoints=kp}) end },
}

function Stubs.typeof(v: any): string
	if type(v) == "table" and v.__type then return v.__type end
	return type(v)
end

Stubs.json = {
	encode = function(t) return serde.encode("json", t) end,
	decode = function(s) return serde.decode("json", s) end,
}

-- ---- fake DataModel tree (mirrors test/mock-bridge.ts fakeTree) ----------
-- Instance API used by core: .Name .ClassName .Parent :GetChildren() :FindFirstChild() :IsA() :GetFullName()
local function makeInstance(name: string, className: string, props: {[string]: any}?)
	local inst
	inst = {
		__type = "Instance",
		Name = name, ClassName = className, Parent = nil,
		_children = {}, _props = props or {},
	}
	function inst.GetChildren() return inst._children end
	function inst.FindFirstChild(_, childName)
		for _, c in inst._children do if c.Name == childName then return c end end
		return nil
	end
	function inst.IsA(_, klass) return inst.ClassName == klass end
	function inst.GetFullName()
		local trail, cur = {}, inst
		while cur do table.insert(trail, 1, cur.Name); cur = cur.Parent end
		return table.concat(trail, ".")
	end
	-- property access via index: core reads inst[name]; back it with _props + intrinsics
	return setmetatable(inst, { __index = function(_, k) return inst._props[k] end })
end

local function addChild(parent, child) child.Parent = parent; table.insert(parent._children, child) end

function Stubs.makeGame()
	local game = makeInstance("game", "DataModel")
	local ws = makeInstance("Workspace", "Workspace")
	local part = makeInstance("Part", "Part", { Anchored = false, Position = Vector3.new(0,5,0) })
	local folder = makeInstance("Stuff", "Folder")  -- class NOT in CLASS_PROPS -> exercises UNIVERSAL fallback
	addChild(ws, part); addChild(ws, folder)
	local rs = makeInstance("ReplicatedStorage", "ReplicatedStorage")
	local buy = makeInstance("Buy", "RemoteEvent")
	local ping = makeInstance("Ping", "RemoteFunction")  -- InvokeServer returns itself (see makeInstance)
	local logic = makeInstance("Logic", "ModuleScript", { Source = "return {}" })
	addChild(rs, buy); addChild(rs, ping); addChild(rs, logic)
	addChild(game, ws); addChild(game, rs)
	return game
end

-- Build a full env for makeCodec/makeCore.
function Stubs.makeEnv()
	return {
		typeof = Stubs.typeof,
		datatypes = Stubs.datatypes,
		json = Stubs.json,
		game = Stubs.makeGame(),
		task = { wait = function() end, spawn = function(fn) fn() end },
		exec = {}, -- no executor globals in tests (hookmetamethod etc. absent)
	}
end

return Stubs
```

- [ ] **Step 4: Create `bridge/test/run-tests.luau` (runner)**

```lua
--!strict
-- Runs every lune test module; each module returns the number of assertions run.
local modules = { "codec.test", "core.test" }
local total = 0
for _, name in modules do
	local count = require("./" .. name)
	print(("✓ %s (%d checks)"):format(name, count))
	total += count
end
print(("ALL BRIDGE TESTS PASSED — %d checks"):format(total))
```

- [ ] **Step 5: Verify the harness loads (no tests yet)**

Run: `lune run bridge/test/stubs.luau`
Expected: exits 0 (module just returns a table; nothing printed). If `require("@lune/serde")` errors, the lune version is too old — report it.

- [ ] **Step 6: Commit**

```bash
git add bridge/test/stubs.luau bridge/test/run-tests.luau package.json
git commit -m "chore(bridge): add lune test harness and Roblox stubs"
```

---

## Task 1: Codec — encode (lune TDD)

**Files:**
- Create: `bridge/codec.luau`, `bridge/test/codec.test.luau`

- [ ] **Step 1: Write the failing test `bridge/test/codec.test.luau`**

```lua
--!strict
local Stubs = require("./stubs")
local makeCodec = require("../codec")
local env = Stubs.makeEnv()
local Codec = makeCodec(env)
local dt = env.datatypes
local checks = 0
local function check(actual, expected, msg) Stubs.assertEq(actual, expected, msg); checks += 1 end

-- a fake encodeInstance the codec calls for Instance values
local function encInst(inst) return { __t = "Instance", ref = 7, path = "game.X", class = inst.ClassName } end

-- primitives pass through
check(Codec.encode(42), 42, "number")
check(Codec.encode("hi"), "hi", "string")
check(Codec.encode(true), true, "bool")

-- finite() guards NaN/Inf
check(Codec.finite(0/0), 0, "nan")
check(Codec.finite(math.huge), 0, "inf")

-- tagged shapes EXACTLY match protocol.ts (lowercase keys)
check(Codec.encode(dt.Vector3.new(1,2,3)), { __t="Vector3", x=1, y=2, z=3 }, "vec3")
check(Codec.encode(dt.Color3.new(1,0,0)), { __t="Color3", r=1, g=0, b=0 }, "color3")
check(Codec.encode(dt.UDim2.new(0,100,0,50)),
	{ __t="UDim2", x={scale=0,offset=100}, y={scale=0,offset=50} }, "udim2")
check(Codec.encode(dt.CFrame.new(0,0,0, 1,0,0, 0,1,0, 0,0,1)),
	{ __t="CFrame", components={0,0,0,1,0,0,0,1,0,0,0,1} }, "cframe 12 components")
check(Codec.encode(dt.Enum.Material.Plastic),
	{ __t="EnumItem", enum="Material", name="Plastic", value=0 }, "enumitem enum-not-prefixed")

-- Instance delegates to encodeInstance (field is `class`, not className)
local fakeInst = { __type="Instance", ClassName="Part" }
check(Codec.encode(fakeInst, encInst), { __t="Instance", ref=7, path="game.X", class="Part" }, "instance via encInst")

return checks
```

- [ ] **Step 2: Run to verify it fails**

Run: `lune run bridge/test/codec.test.luau`
Expected: FAIL — `module '../codec' not found`.

- [ ] **Step 3: Write `bridge/codec.luau`**

```lua
--!strict
-- Pure tagged-value codec. Factory takes an env so it is fully unit-testable
-- without a Roblox runtime. Wire shapes mirror src/protocol.ts TaggedValueSchema
-- EXACTLY (lowercase json keys; Instance uses `class`; CFrame is 12 components).
return function(env)
	local typeof = env.typeof
	local dt = env.datatypes

	local Codec = {}

	local function finite(n: number): number
		if n ~= n or n == math.huge or n == -math.huge then return 0 end
		return n
	end
	Codec.finite = finite

	-- encode(value, encodeInstance): encodeInstance(inst) -> {__t="Instance",ref,path,class}
	function Codec.encode(v: any, encodeInstance: ((any) -> any)?): any
		local t = typeof(v)
		if t == "number" then return finite(v)
		elseif t == "string" or t == "boolean" then return v
		elseif t == "nil" then return { __t = "Unsupported", repr = "nil" }
		elseif t == "Vector3" then return { __t="Vector3", x=finite(v.X), y=finite(v.Y), z=finite(v.Z) }
		elseif t == "Vector2" then return { __t="Vector2", x=finite(v.X), y=finite(v.Y) }
		elseif t == "CFrame" then
			local c = { v:GetComponents() }
			for i = 1, 12 do c[i] = finite(c[i]) end
			return { __t="CFrame", components = c }
		elseif t == "Color3" then return { __t="Color3", r=finite(v.R), g=finite(v.G), b=finite(v.B) }
		elseif t == "BrickColor" then return { __t="BrickColor", name=v.Name }
		elseif t == "UDim" then return { __t="UDim", scale=finite(v.Scale), offset=finite(v.Offset) }
		elseif t == "UDim2" then
			return { __t="UDim2",
				x={scale=finite(v.X.Scale), offset=finite(v.X.Offset)},
				y={scale=finite(v.Y.Scale), offset=finite(v.Y.Offset)} }
		elseif t == "EnumItem" then
			-- enum name must be unprefixed ("Material"), matching Enum[enum][name] decode
			local enumName = (tostring(v.EnumType):gsub("^Enum%.", ""))
			return { __t="EnumItem", enum=enumName, name=v.Name, value=v.Value }
		elseif t == "Instance" then
			if encodeInstance then return encodeInstance(v) end
			return { __t="Unsupported", repr="Instance(no encoder)" }
		elseif t == "NumberSequence" then
			local kp = {}
			for i, k in v.Keypoints do kp[i] = { time=finite(k.Time), value=finite(k.Value), envelope=finite(k.Envelope) } end
			return { __t="NumberSequence", keypoints=kp }
		elseif t == "ColorSequence" then
			local kp = {}
			for i, k in v.Keypoints do kp[i] = { time=finite(k.Time), value={r=finite(k.Value.R), g=finite(k.Value.G), b=finite(k.Value.B)} } end
			return { __t="ColorSequence", keypoints=kp }
		else
			return { __t="Unsupported", repr=tostring(v) }
		end
	end

	-- decode implemented in Task 2.
	function Codec.decode(_v: any, _valueType: string?, _current: any, _resolve: ((number) -> any)?): any
		error("decode not implemented")
	end

	return Codec
end
```

- [ ] **Step 4: Run to verify it passes**

Run: `lune run bridge/test/codec.test.luau`
Expected: PASS — returns a check count, no error thrown.

- [ ] **Step 5: Commit**

```bash
git add bridge/codec.luau bridge/test/codec.test.luau
git commit -m "feat(bridge): tagged-value encode codec (lune-tested)"
```

---

## Task 2: Codec — decode (lune TDD)

**Files:**
- Modify: `bridge/codec.luau`, `bridge/test/codec.test.luau`

- [ ] **Step 1: Append decode tests to `bridge/test/codec.test.luau`** (before the final `return checks`)

```lua
-- DECODE: tagged-first
local resolved = { __type="Instance", ClassName="Part" }
local function resolve(ref) return ref == 7 and resolved or nil end

check(env.typeof(Codec.decode({__t="Vector3", x=1, y=2, z=3})), "Vector3", "decode vec3 type")
local v = Codec.decode({__t="Vector3", x=1, y=2, z=3})
check({v.X, v.Y, v.Z}, {1,2,3}, "decode vec3 values")
check(Codec.decode({__t="CFrame", components={0,0,0,1,0,0,0,1,0,0,0,1}}).GetComponents and "ok" or "no", "ok", "decode cframe")
check(Codec.decode({__t="Color3", r=1, g=0, b=0}).R, 1, "decode color3 uses .new not fromRGB")
check(Codec.decode({__t="EnumItem", enum="Material", name="Plastic"}).Name, "Plastic", "decode enum by name")
-- round-trip an EnumItem that also carries `value` (encode always includes it; decode prefers name)
check(Codec.decode(Codec.encode(dt.Enum.Material.Plastic)).Name, "Plastic", "enum round-trip prefers name over value")
check(Codec.decode({__t="Instance", ref=7}, nil, nil, resolve), resolved, "decode instance via resolve")

-- DECODE: primitive + valueType coercion
check(Codec.decode("5", "float"), 5, "coerce float")
check(Codec.decode(1, "bool"), true, "coerce bool from 1")
check(Codec.decode(0, "bool"), false, "coerce bool from numeric 0 (Lua: 0 is truthy, must be false)")
check(Codec.decode(123, "string"), "123", "coerce string")

-- DECODE: unknown valueType -> coerce to current property's type
check(Codec.decode("9", nil, 0), 9, "fallback to current number")
check(Codec.decode(0, nil, true), false, "fallback to current bool")
```

- [ ] **Step 2: Run to verify the new asserts fail**

Run: `lune run bridge/test/codec.test.luau`
Expected: FAIL — `decode not implemented`.

- [ ] **Step 3: Replace the `Codec.decode` stub in `bridge/codec.luau`**

```lua
	local function decodeTagged(v: any): any
		local tag = v.__t
		if tag == "Vector3" then return dt.Vector3.new(v.x, v.y, v.z)
		elseif tag == "Vector2" then return dt.Vector2.new(v.x, v.y)
		elseif tag == "CFrame" then return dt.CFrame.new(table.unpack(v.components))
		elseif tag == "Color3" then return dt.Color3.new(v.r, v.g, v.b) -- 0..1, NOT fromRGB
		elseif tag == "BrickColor" then return dt.BrickColor.new(v.name)
		elseif tag == "UDim" then return dt.UDim.new(v.scale, v.offset)
		elseif tag == "UDim2" then return dt.UDim2.new(v.x.scale, v.x.offset, v.y.scale, v.y.offset)
		elseif tag == "EnumItem" then
			-- prefer by NAME (stable across Roblox version bumps where numeric Values shift);
			-- FromValue is the fallback only when name is absent.
			local e = (dt.Enum :: any)[v.enum]
			if v.name ~= nil then return e[v.name] else return e:FromValue(v.value) end
		else
			error("cannot decode tag " .. tostring(tag))
		end
	end

	-- Lua truthiness differs from JS: 0 / "" / NaN are all truthy (only nil/false are falsy).
	-- For property coercion a numeric 0 must mean false, so don't use `not not v` on numbers.
	local function toBoolean(v: any): boolean
		if type(v) == "number" then return v ~= 0 end
		return not not v
	end

	local function coerceByValueType(v: any, vt: string, current: any): any
		if vt == "bool" then return toBoolean(v)
		elseif vt == "string" or vt == "Content" or vt == "ContentId" then return tostring(v)
		elseif vt == "float" or vt == "double" or vt == "int" or vt == "int64" or vt == "number" then return tonumber(v)
		elseif vt == "BrickColor" then return dt.BrickColor.new(tostring(v))
		elseif vt == "Enum" and typeof(current) == "EnumItem" then
			if type(v) == "number" then return current.EnumType:FromValue(v) end
			return (current.EnumType :: any)[tostring(v)]
		end
		return v
	end

	function Codec.decode(v: any, valueType: string?, current: any, resolve: ((number) -> any)?): any
		if type(v) == "table" and v.__t ~= nil then
			if v.__t == "Instance" then
				if not resolve then error("instance decode needs a resolver") end
				return resolve(v.ref)
			end
			return decodeTagged(v)
		end
		if valueType ~= nil and valueType ~= "unknown" then
			return coerceByValueType(v, valueType, current)
		end
		local ct = typeof(current)
		if ct == "number" then return tonumber(v)
		elseif ct == "boolean" then return toBoolean(v)
		elseif ct == "string" then return tostring(v)
		elseif ct == "EnumItem" then
			if type(v) == "number" then return current.EnumType:FromValue(v) end
			return (current.EnumType :: any)[tostring(v)]
		end
		return v
	end
```

- [ ] **Step 4: Run to verify it passes**

Run: `lune run bridge/test/codec.test.luau`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/codec.luau bridge/test/codec.test.luau
git commit -m "feat(bridge): tagged-value decode with valueType + current-type fallback"
```

---

## Task 3: TS contract test — shapes ↔ RobloxValueSchema (vitest TDD)

**Files:**
- Create: `test/bridge-codec-contract.test.ts`

This locks, from the TS side, that the exact tagged shapes the bridge emits are accepted by the server's `RobloxValueSchema`. Combined with Task 1/2 (which prove the Luau encoder produces these shapes) this is the wire-compat proof.

- [ ] **Step 1: Write the test**

```ts
import { describe, it, expect } from "vitest";
import { RobloxValueSchema, TaggedValueSchema } from "../src/protocol.js";

// Canonical tagged values the Luau bridge produces (must match bridge/codec.luau encode()).
const CANONICAL: Record<string, unknown> = {
  number: 42,
  string: "hi",
  boolean: true,
  Vector3: { __t: "Vector3", x: 1, y: 2, z: 3 },
  Vector2: { __t: "Vector2", x: 1, y: 2 },
  CFrame: { __t: "CFrame", components: [0,0,0, 1,0,0, 0,1,0, 0,0,1] },
  Color3: { __t: "Color3", r: 1, g: 0, b: 0 },
  BrickColor: { __t: "BrickColor", name: "Bright red" },
  UDim: { __t: "UDim", scale: 0, offset: 100 },
  UDim2: { __t: "UDim2", x: { scale: 0, offset: 100 }, y: { scale: 0, offset: 50 } },
  EnumItem: { __t: "EnumItem", enum: "Material", name: "Plastic", value: 256 },
  Instance: { __t: "Instance", ref: 7, path: "game.Workspace.Part", class: "Part" },
  Unsupported: { __t: "Unsupported", repr: "Axes" },
};

describe("bridge codec wire contract", () => {
  for (const [name, value] of Object.entries(CANONICAL)) {
    it(`RobloxValueSchema accepts the bridge's ${name} shape`, () => {
      expect(() => RobloxValueSchema.parse(value)).not.toThrow();
    });
  }

  it("rejects an Instance shape using className instead of class", () => {
    // guards against the easy mistake — Node uses className, tagged Instance uses class
    expect(() => TaggedValueSchema.parse({ __t: "Instance", ref: 1, path: "x", className: "Part" })).toThrow();
  });

  it("rejects a CFrame with wrong component count", () => {
    expect(() => TaggedValueSchema.parse({ __t: "CFrame", components: [1, 2, 3] })).toThrow();
  });
});
```

> **Scope of this test:** it locks the STRUCTURE the schema accepts (keys, `class` vs `className`, CFrame arity). It does NOT prove the Luau encoder produces correct semantics — e.g. `enum` is `z.string()`, so an encoder bug emitting `enum: "nil"` would still pass here. The *semantic* correctness of `enum`/`value`/numeric round-trips is locked by the **Task 1/2 lune tests**, which assert exact values. The two together = wire compatibility.

- [ ] **Step 2: Run to verify it passes (schema already exists)**

Run: `npx vitest run test/bridge-codec-contract.test.ts`
Expected: PASS (all canonical shapes accepted; the two negative cases throw). If any canonical shape is REJECTED, the bridge codec shape is wrong — fix `bridge/codec.luau` (and Task 1/2 tests) to match the schema, not the schema to match the bridge.

- [ ] **Step 3: Commit**

```bash
git add test/bridge-codec-contract.test.ts
git commit -m "test: lock bridge tagged shapes against RobloxValueSchema"
```

---

## Task 4: core.luau — ref tables, dotPath, buildNode (lune TDD)

**Files:**
- Create: `bridge/core.luau`, `bridge/test/core.test.luau`

- [ ] **Step 1: Write the failing test `bridge/test/core.test.luau`**

```lua
--!strict
local Stubs = require("./stubs")
local makeCore = require("../core")
local checks = 0
local function check(a, e, m) Stubs.assertEq(a, e, m); checks += 1 end

local env = Stubs.makeEnv()
local core = makeCore(env)
local game = env.game

-- game is ref 0
check(core.refFor(game), 0, "game ref 0")
-- dedupe: same instance -> same ref
local ws = game._children[1]
local r1 = core.refFor(ws)
check(core.refFor(ws), r1, "dedupe ref")
-- resolve round-trips; unknown ref throws exact message
check(core.resolve(0), game, "resolve game")
local ok, err = pcall(core.resolve, 999)
check(ok, false, "resolve miss throws")
check(tostring(err):find("stale ref 999", 1, true) ~= nil, true, "exact stale-ref wording")

-- dotPath / buildNode
check(core.dotPath(ws), "game.Workspace", "dotPath")
local node = core.buildNode(ws)
check(node.name, "Workspace", "node name")
check(node.className, "Workspace", "node className")
check(node.path, "game.Workspace", "node path")
check(node.childCount, 2, "node childCount is number")  -- Workspace has Part + Stuff (Folder)

return checks
```

- [ ] **Step 2: Run to verify it fails**

Run: `lune run bridge/test/core.test.luau`
Expected: FAIL — `module '../core' not found`.

- [ ] **Step 3: Write `bridge/core.luau` (ref/node section; handlers stubbed for now)**

```lua
--!strict
-- Pure bridge core. Factory takes env { typeof, datatypes, json, game, task, exec, Codec? }.
-- Returns ref tables, node builder, RPC handlers, and dispatch(raw)->replyString.
return function(env)
	local typeof = env.typeof
	local game = env.game
	local Codec = env.Codec  -- set by callers before handlers run; ref/node tasks don't touch it

	local Core = {}

	-- ---- ref tables (weak both ways; game pinned at 0) ------------------
	local refToInstance = setmetatable({}, { __mode = "v" })
	local instanceToRef = setmetatable({}, { __mode = "k" })
	local nextId = 1
	instanceToRef[game] = 0
	refToInstance[0] = game

	local function refFor(inst)
		local existing = instanceToRef[inst]
		if existing ~= nil then return existing end
		local id = nextId
		nextId += 1
		instanceToRef[inst] = id
		refToInstance[id] = inst
		return id
	end
	Core.refFor = refFor

	local function resolve(ref)
		local inst = refToInstance[ref]
		if inst == nil then error(("stale ref %d"):format(ref)) end
		return inst
	end
	Core.resolve = resolve

	-- ---- dot path: walk .Parent up to game, join with "." -------------
	local function dotPath(inst)
		local trail, cur = {}, inst
		while cur ~= nil do
			table.insert(trail, 1, cur.Name)
			if cur == game then break end
			cur = cur.Parent
		end
		return table.concat(trail, ".")
	end
	Core.dotPath = dotPath

	local function buildNode(inst)
		return {
			ref = refFor(inst),
			name = inst.Name,
			className = inst.ClassName,
			path = dotPath(inst),
			childCount = #inst:GetChildren(),
		}
	end
	Core.buildNode = buildNode

	-- encodeInstance used by the codec for Instance-valued properties
	local function encodeInstance(inst)
		return { __t = "Instance", ref = refFor(inst), path = dotPath(inst), class = inst.ClassName }
	end
	Core.encodeInstance = encodeInstance

	-- handlers + dispatch added in later tasks.
	Core._internal = { refToInstance = refToInstance, instanceToRef = instanceToRef }
	return Core
end
```

> Note: `local Codec = env.Codec` is `nil` here and that's fine — the ref/node helpers in this task never touch the codec. Read handlers (Task 5) require callers to set `env.Codec` first; the prod glue (Task 8) and the handler tests both do.

> **Weak-ref caveat (document, do not work around):** because `refToInstance` holds weak VALUES, a ref handed to the server can be GC'd between RPCs if its Instance becomes unparented and nothing else holds it. Parented Instances are held by the engine and stay valid. `resolve()` turning a vanished ref into `stale ref <N>` (a clean RPC error) is the intended degradation.

- [ ] **Step 4: Run to verify it passes**

Run: `lune run bridge/test/core.test.luau`
Expected: PASS.

- [ ] **Step 5: Commit**

```bash
git add bridge/core.luau bridge/test/core.test.luau
git commit -m "feat(bridge): core ref tables, dotPath, node builder (lune-tested)"
```

---

## Task 5: core.luau — read handlers + dispatch (lune TDD)

**Files:**
- Modify: `bridge/core.luau`, `bridge/test/core.test.luau`

- [ ] **Step 1: Append handler/dispatch tests to `bridge/test/core.test.luau`** (before `return checks`)

```lua
-- wire a codec into the env for the handler tests
local makeCodec = require("../codec")
local env2 = Stubs.makeEnv()
env2.Codec = makeCodec(env2)
local core2 = makeCore(env2)
local game2 = env2.game

-- helper: call dispatch with a request, decode the reply
local function call(method, params)
	local raw = env2.json.encode({ id = 1, method = method, params = params })
	return env2.json.decode(core2.dispatch(raw))
end

-- status
local s = call("status", {})
check(s.ok, true, "status ok")
check(s.result.gameName ~= nil, true, "status has gameName")
check(type(s.result.capabilities), "table", "status capabilities table")

-- getRoot: node ref 0 + services as BARE array of nodes
local root = call("getRoot", {})
check(root.result.node.ref, 0, "root ref 0")
check(root.result.node.className, "DataModel", "root className")
check(#root.result.services >= 2, true, "root services array")

-- getChildren: BARE Node[] (no wrapper)
local wsRef = root.result.services[1].ref
local children = call("getChildren", { ref = wsRef })
check(children.result[1] ~= nil, true, "getChildren bare array")

-- search: BARE Node[], name substring
local found = call("search", { query = "part" })
check(found.result[1].name, "Part", "search finds Part")

-- getByPath: BARE single node
local byPath = call("getByPath", { path = "game.Workspace.Part" })
check(byPath.result.name, "Part", "getByPath bare node")

-- getSource: ModuleScript Logic has source; Workspace does not -> error
local rsRef = root.result.services[2].ref
local logic = call("getChildren", { ref = rsRef })
local logicNode
for _, n in logic.result do if n.className == "ModuleScript" then logicNode = n end end
local src = call("getSource", { ref = logicNode.ref })
check(src.result.source, "return {}", "getSource ok")
local noSrc = call("getSource", { ref = wsRef })
check(noSrc.ok, false, "getSource error path")

-- unknown method -> error reply with id
local unk = call("frobnicate", {})
check(unk.ok, false, "unknown method error")
check(unk.id, 1, "error reply echoes id")

-- dispatch strips Lua's "chunk:line:" prefix so errors byte-match the frozen mock strings
check(unk.error, "unknown method frobnicate", "exact unknown-method string")
check(call("getByPath", { path = "game.Nope" }).error, "path not found: game.Nope", "exact path-not-found")
check(call("getProperties", { ref = 99999 }).error, "stale ref 99999", "exact stale-ref (prefix stripped)")

-- search honors maxDepth (only direct children of root) and rootRef (scoped subtree)
local shallow = call("search", { query = "", maxDepth = 1 })
local sn = {}
for _, n in shallow.result do sn[n.name] = true end
check(sn["Workspace"] == true and sn["Part"] == nil, true, "maxDepth=1 excludes deep Part")
local scoped = call("search", { query = "part", rootRef = root.result.services[1].ref })
check(scoped.result[1].name, "Part", "rootRef scopes search to Workspace")

-- getProperties on a Folder (not in CLASS_PROPS): UNIVERSAL fallback, non-empty map
local folder = call("getByPath", { path = "game.Workspace.Stuff" })
local fprops = call("getProperties", { ref = folder.result.ref })
check(fprops.result.properties.Name, "Stuff", "folder fallback includes Name")
check(fprops.result.properties.ClassName, "Folder", "folder fallback includes ClassName")

return checks
```

- [ ] **Step 2: Run to verify it fails**

Run: `lune run bridge/test/core.test.luau`
Expected: FAIL — `core2.dispatch` is nil / handlers missing.

- [ ] **Step 3: Add read handlers + dispatch to `bridge/core.luau`** (insert before `Core._internal = ...`)

```lua
	-- ---- read/explore handlers ----------------------------------------
	local function encodeValue(v) return Codec.encode(v, encodeInstance) end

	local function readProp(inst, name)
		return pcall(function() return (inst :: any)[name] end)
	end

	-- curated per-class fallback when no propertyNames are supplied
	local UNIVERSAL = { "Name", "ClassName", "Parent" }
	local CLASS_PROPS = {
		BasePart = { "Anchored","Position","Size","CFrame","Color","Transparency","CanCollide","Material" },
		Model = { "PrimaryPart","WorldPivot" },
		Humanoid = { "Health","MaxHealth","WalkSpeed","JumpPower","DisplayName" },
		LuaSourceContainer = { "Source" },
		GuiObject = { "Visible","Position","Size","BackgroundColor3","BackgroundTransparency","ZIndex" },
		ValueBase = { "Value" },
	}
	local function fallbackNames(inst)
		local seen, out = {}, {}
		local function add(n) if not seen[n] then seen[n] = true; table.insert(out, n) end end
		for _, n in UNIVERSAL do add(n) end
		for class, names in CLASS_PROPS do
			local okIsA, isa = pcall(function() return inst:IsA(class) end)
			if okIsA and isa then for _, n in names do add(n) end end
		end
		-- richer set when the executor exposes getproperties()
		local gp = env.exec and env.exec.getproperties
		if type(gp) == "function" then
			local okGp, names = pcall(gp, inst)
			if okGp and type(names) == "table" then for _, n in names do add(n) end end
		end
		return out
	end

	local Handlers = {}

	function Handlers.status(_params)
		local exec = env.exec or {}
		return {
			gameName = game.Name,
			placeId = game.PlaceId or 0,
			clientVersion = "dex-bridge/0.1.0",
			capabilities = {
				hookmetamethod = type(exec.hookmetamethod) == "function",
				getrawmetatable = type(exec.getrawmetatable) == "function",
				getnamecallmethod = type(exec.getnamecallmethod) == "function",
				loadstring = type(exec.loadstring) == "function",
				getproperties = type(exec.getproperties) == "function",
			},
		}
	end

	function Handlers.getRoot(_params)
		local services = {}
		for _, child in game:GetChildren() do table.insert(services, buildNode(child)) end
		return { node = buildNode(game), services = services }
	end

	function Handlers.getChildren(params)
		local inst = resolve(params.ref)
		local out = {}
		for _, child in inst:GetChildren() do
			if (params.classFilter == nil) or (child.ClassName == params.classFilter) then
				table.insert(out, buildNode(child))
			end
		end
		return out  -- BARE array (frozen contract)
	end

	function Handlers.getProperties(params)
		local inst = resolve(params.ref)
		local names = params.propertyNames or fallbackNames(inst)
		local properties = {}
		-- UNIVERSAL ("Name","ClassName") always read OK -> `properties` is never an empty map.
		-- This matters: HttpService:JSONEncode encodes an empty table as [] (array), which would
		-- violate the Record<string,RobloxValue> contract for `properties`. Keep it non-empty.
		for _, name in names do
			local okRead, value = readProp(inst, name)
			if okRead and value ~= nil then properties[name] = encodeValue(value) end
		end
		return { className = inst.ClassName, properties = properties }
	end

	function Handlers.search(params)
		local limit = params.limit or 100
		local q = string.lower(params.query or "")
		local classFilter = params.classFilter
		-- Honor rootRef + maxDepth (spec §4/§8). When rootRef is nil/game and maxDepth is nil this
		-- walks every descendant of game's children — byte-identical to the mock, so the 34 tests hold.
		local rootInst = (params.rootRef ~= nil and resolve(params.rootRef)) or game
		local maxDepth = params.maxDepth  -- nil => unbounded; root's direct children = depth 1
		local out = {}
		-- depth = depth of `inst` relative to rootInst (rootInst's children are depth 1)
		local function visit(inst, depth)
			if #out >= limit then return end
			local nameHit = string.find(string.lower(inst.Name), q, 1, true) ~= nil
			if nameHit and (classFilter == nil or inst.ClassName == classFilter) then
				table.insert(out, buildNode(inst))
			end
			if maxDepth ~= nil and depth >= maxDepth then return end
			for _, child in inst:GetChildren() do
				if #out >= limit then return end
				visit(child, depth + 1)
			end
		end
		-- rootInst itself is excluded from matching (mock walks root.children)
		for _, child in rootInst:GetChildren() do
			if #out >= limit then break end
			visit(child, 1)
		end
		return out  -- BARE array
	end

	function Handlers.getByPath(params)
		local segs = string.split(params.path, ".")
		local cur = game
		for i = 2, #segs do  -- drop first segment ("game")
			local nextInst = cur:FindFirstChild(segs[i])
			if nextInst == nil then error("path not found: " .. params.path) end
			cur = nextInst
		end
		return buildNode(cur)  -- BARE node
	end

	function Handlers.getSource(params)
		local inst = resolve(params.ref)
		local okRead, src = readProp(inst, "Source")
		if (not okRead) or src == nil then error("instance has no readable source") end
		return { source = src }
	end

	-- ---- dispatch: {id,method,params} -> reply string ------------------
	Core.Handlers = Handlers
	function Core.dispatch(raw)
		local okDecode, msg = pcall(env.json.decode, raw)
		if not okDecode then
			return env.json.encode({ ok = false, error = "malformed request frame" })
		end
		local fn = Handlers[msg.method]
		if fn == nil then
			return env.json.encode({ id = msg.id, ok = false, error = "unknown method " .. tostring(msg.method) })
		end
		local okRun, result = pcall(fn, msg.params or {})
		if okRun then
			return env.json.encode({ id = msg.id, ok = true, result = result })
		end
		-- Lua's error() prepends "chunk:line: "; strip it so the message byte-matches the
		-- frozen mock strings (e.g. "stale ref 7", "path not found: x") the 34 server tests assert.
		local message = tostring(result):gsub("^[^\n]-:%d+: ", "")
		return env.json.encode({ id = msg.id, ok = false, error = message })
	end
```

> `Codec` (`env.Codec`) must be non-nil for read handlers; the Step 1 test sets `env2.Codec` and the prod glue (Task 8) sets `env.Codec` before `makeCore`. (The dead `makeCodec = env.makeCodec or require` line was already removed in Task 4.)

- [ ] **Step 4: Run to verify it passes**

Run: `lune run bridge/test/core.test.luau`
Expected: PASS.

- [ ] **Step 5: Run the whole bridge suite**

Run: `npm run test:bridge`
Expected: both modules pass (`ALL BRIDGE TESTS PASSED`).

- [ ] **Step 6: Commit**

```bash
git add bridge/core.luau bridge/test/core.test.luau
git commit -m "feat(bridge): read/explore handlers + dispatch envelope (lune-tested)"
```

---

## Task 6: core.luau — write + remotes handlers (lune TDD)

**Files:**
- Modify: `bridge/core.luau`, `bridge/test/core.test.luau`

- [ ] **Step 1: Append tests** (before `return checks`)

```lua
-- setProperty: decode + assign + {ok=true}
local partByPath = call("getByPath", { path = "game.Workspace.Part" })
local setRes = call("setProperty", { ref = partByPath.result.ref, name = "Name", value = "Renamed" })
check(setRes.result.ok, true, "setProperty ok=true")

-- fireRemote on the Buy RemoteEvent -> {ok=true}; mock-equivalent shape
local rsNode = call("getByPath", { path = "game.ReplicatedStorage" })
local buy = call("getChildren", { ref = rsNode.result.ref, classFilter = "RemoteEvent" })
local fired = call("fireRemote", { ref = buy.result[1].ref, args = {} })
check(fired.result.ok, true, "fireRemote ok=true")

-- invokeRemote on the Ping RemoteFunction (stub InvokeServer returns itself) -> {result=tagged Instance}
local ping = call("getChildren", { ref = rsNode.result.ref, classFilter = "RemoteFunction" })
local inv = call("invokeRemote", { ref = ping.result[1].ref, args = {} })
check(inv.result.result.__t, "Instance", "invokeRemote return is codec-encoded")
check(inv.result.result.class, "RemoteFunction", "invoke result Instance uses field `class`, not className")
```

> For these to run under lune, the stub `Part`/`RemoteEvent` instances need writable property assignment and a fake `FireServer`. Update `bridge/test/stubs.luau` `makeInstance` so `__newindex` writes into `_props`, and add `inst.FireServer = function() end` / `inst.InvokeServer = function() return inst end` on instances whose className is `RemoteEvent`/`RemoteFunction`. (Add these two lines in `makeInstance` guarded by `className`.)

- [ ] **Step 2: Update `bridge/test/stubs.luau` `makeInstance`** — add before `return setmetatable(...)`:

```lua
	if className == "RemoteEvent" then inst.FireServer = function() end end
	if className == "RemoteFunction" then inst.InvokeServer = function(_, ...) return inst end end
	-- writable properties
	return setmetatable(inst, {
		__index = function(_, k) return inst._props[k] end,
		__newindex = function(_, k, v) inst._props[k] = v end,
	})
```
(Replace the existing single-metamethod `setmetatable` return.)

- [ ] **Step 3: Run to verify it fails**

Run: `lune run bridge/test/core.test.luau`
Expected: FAIL — `setProperty`/`fireRemote` handlers missing.

- [ ] **Step 4: Add write+remotes handlers to `bridge/core.luau`** (after `Handlers.getSource`)

```lua
	function Handlers.setProperty(params)
		local inst = resolve(params.ref)
		local okCur, current = readProp(inst, params.name)
		local decoded = Codec.decode(params.value, params.valueType, okCur and current or nil, resolve)
		;(inst :: any)[params.name] = decoded
		return { ok = true }
	end

	local function decodeArgs(args)
		local out = {}
		for i, a in (args or {}) do out[i] = Codec.decode(a, nil, nil, resolve) end
		return out
	end

	function Handlers.fireRemote(params)
		local inst = resolve(params.ref)
		assert(inst:IsA("RemoteEvent"), "fire_remote expects a RemoteEvent")
		inst:FireServer(table.unpack(decodeArgs(params.args)))
		return { ok = true }
	end

	function Handlers.invokeRemote(params)
		local inst = resolve(params.ref)
		assert(inst:IsA("RemoteFunction"), "invoke_remote expects a RemoteFunction")
		local res = inst:InvokeServer(table.unpack(decodeArgs(params.args)))
		return { result = encodeValue(res) }  -- Instance returns use field `class`
	end
```

- [ ] **Step 5: Run to verify it passes; then full bridge suite**

Run: `lune run bridge/test/core.test.luau` → PASS
Run: `npm run test:bridge` → PASS

- [ ] **Step 6: Commit**

```bash
git add bridge/core.luau bridge/test/core.test.luau bridge/test/stubs.luau
git commit -m "feat(bridge): write + remotes handlers (lune-tested)"
```

---

## Task 7: core.luau — runLuau + capability-gated remote spy

**Files:**
- Modify: `bridge/core.luau`, `bridge/test/core.test.luau`

`runLuau` (loadstring/setfenv) and the `__namecall` hook cannot run under lune. We TDD only the **capability gate** (spy must hard-error when the executor lacks hooks) and `runLuau`'s **disabled/compile-error** branches via injectable `env.exec`. Real behavior is validated manually (Tasks 12–13).

- [ ] **Step 1: Append tests** (before `return checks`)

```lua
-- remote spy hard-errors when executor capabilities are absent (env.exec is empty in tests)
local spy = call("remoteSpyStart", {})
check(spy.ok, false, "remoteSpyStart unsupported -> error")
check(spy.error, "remote spy unsupported by this executor", "spy unsupported exact wording (prefix stripped by dispatch)")

-- remoteSpyDump returns {entries=...} even before any capture (empty)
local dump = call("remoteSpyDump", {})
check(type(dump.result.entries), "table", "dump entries table")

-- runLuau compile error -> {output=<err>} via a stub loadstring
local env3 = Stubs.makeEnv()
env3.Codec = require("../codec")(env3)
env3.exec = { loadstring = function(code) return nil, "syntax error near X" end }
local core3 = makeCore(env3)
local raw = env3.json.encode({ id = 9, method = "runLuau", params = { code = "bad(" } })
local rl = env3.json.decode(core3.dispatch(raw))
check(rl.result.output, "syntax error near X", "runLuau compile error output")

return checks
```

- [ ] **Step 2: Run to verify it fails**

Run: `lune run bridge/test/core.test.luau`
Expected: FAIL — handlers missing.

- [ ] **Step 3: Add runLuau + spy handlers to `bridge/core.luau`** (after `Handlers.invokeRemote`)

```lua
	-- ---- runLuau (executor loadstring + scoped print capture) ----------
	function Handlers.runLuau(params)
		local exec = env.exec or {}
		if type(exec.loadstring) ~= "function" then error("run_luau unsupported (no loadstring)") end
		local chunk, compileErr = exec.loadstring(params.code)
		if not chunk then return { output = tostring(compileErr) } end
		local buf = {}
		local function capture(...)
			local parts = {}
			for i = 1, select("#", ...) do parts[i] = tostring((select(i, ...))) end
			table.insert(buf, table.concat(parts, "\t"))
		end
		if exec.setfenv then
			local base = (exec.getgenv and exec.getgenv()) or {}
			exec.setfenv(chunk, setmetatable({ print = capture, warn = capture }, { __index = base }))
		end
		local ok, ret = pcall(chunk)
		if not ok then table.insert(buf, "error: " .. tostring(ret)) end
		local result = { output = table.concat(buf, "\n") }
		if ok and ret ~= nil then result.returned = encodeValue(ret) end  -- primitives pass through raw
		return result
	end

	-- ---- remote spy (capability-gated; buffer + dump) ------------------
	local Spy = { active = false, buffer = {} }
	local function spyCapable()
		local e = env.exec or {}
		return type(e.hookmetamethod) == "function"
			and type(e.getrawmetatable) == "function"
			and type(e.getnamecallmethod) == "function"
			and type(e.newcclosure) == "function"
	end

	function Handlers.remoteSpyStart(_params)
		if not spyCapable() then error("remote spy unsupported by this executor") end
		if Spy.active then return { ok = true } end
		Spy.active = true
		local exec = env.exec
		local original
		original = exec.hookmetamethod(game, "__namecall", exec.newcclosure(function(self, ...)
			local method = exec.getnamecallmethod()
			if Spy.active and (method == "FireServer" or method == "InvokeServer") then
				-- read ClassName by DOT-INDEX (NOT a method) to avoid re-entering __namecall
				local okCls, cls = pcall(function() return self.ClassName end)
				if okCls and (cls == "RemoteEvent" or cls == "RemoteFunction") then
					-- store the raw instance; resolve path at DUMP time (outside the hook)
					table.insert(Spy.buffer, { instance = self, method = method, rawArgs = { ... } })
				end
			end
			return original(self, ...)  -- ALWAYS forward
		end))
		return { ok = true }
	end

	function Handlers.remoteSpyStop(_params)
		Spy.active = false  -- cannot cleanly unhook; gate via flag
		return { ok = true }
	end

	function Handlers.remoteSpyDump(_params)
		local entries = {}
		for _, e in Spy.buffer do
			local args = {}
			for i, a in e.rawArgs do args[i] = encodeValue(a) end
			table.insert(entries, { remote = dotPath(e.instance), args = args, method = e.method })
		end
		Spy.buffer = {}
		return { entries = entries }
	end
```

- [ ] **Step 4: Run to verify it passes; full suites**

Run: `lune run bridge/test/core.test.luau` → PASS
Run: `npm run test:bridge` → PASS

- [ ] **Step 5: Commit**

```bash
git add bridge/core.luau bridge/test/core.test.luau
git commit -m "feat(bridge): runLuau + capability-gated remote spy"
```

---

## Task 8: dex-bridge.luau glue (env + WebSocket supervisor + bootstrap)

**Files:**
- Create: `bridge/dex-bridge.luau`

Not lune-testable (WebSocket/task globals). Validated manually in Tasks 12–13. The server (Task 9) prepends `codec.luau` and `core.luau` and substitutes `__DEX_PORT__`/`__DEX_TOKEN__`.

- [ ] **Step 1: Create `bridge/dex-bridge.luau`**

```lua
--!strict
-- DEX-MCP bridge glue. The server prepends codec.luau and core.luau as
-- `makeCodec`/`makeCore` factories and substitutes the markers below.
-- Markers (replaced by src/bridge-hub/bridge-loader.ts):
--   __DEX_MAKECODEC__  -> local makeCodec = (function() <codec.luau> end)()
--   __DEX_MAKECORE__   -> local makeCore  = (function() <core.luau>  end)()
--   __DEX_PORT__       -> the WS/HTTP port number
--   __DEX_TOKEN__      -> the shared token string

__DEX_MAKECODEC__
__DEX_MAKECORE__

local PORT = __DEX_PORT__
local TOKEN = "__DEX_TOKEN__"
local URL = ("ws://127.0.0.1:%d?token=%s"):format(PORT, TOKEN)
local RECONNECT_DELAY = 3

local HttpService = game:GetService("HttpService")

-- Build the env from real executor/Roblox globals.
local env = {
	typeof = typeof,
	game = game,
	task = task,
	json = {
		encode = function(t) return HttpService:JSONEncode(t) end,
		decode = function(s) return HttpService:JSONDecode(s) end,
	},
	datatypes = {
		Vector3 = Vector3, Vector2 = Vector2, CFrame = CFrame, Color3 = Color3,
		BrickColor = BrickColor, UDim = UDim, UDim2 = UDim2, Enum = Enum,
		NumberSequence = NumberSequence, ColorSequence = ColorSequence,
		NumberSequenceKeypoint = NumberSequenceKeypoint, ColorSequenceKeypoint = ColorSequenceKeypoint,
	},
	exec = {
		loadstring = loadstring, setfenv = setfenv, getgenv = getgenv,
		hookmetamethod = hookmetamethod, getrawmetatable = getrawmetatable,
		getnamecallmethod = getnamecallmethod, newcclosure = newcclosure,
		getproperties = getproperties,
	},
}
env.Codec = makeCodec(env)
local Core = makeCore(env)

-- WebSocket connect + reconnect supervisor.
local function connectOnce()
	local ok, ws = pcall(function() return WebSocket.connect(URL) end)  -- THROWS if server down
	if not ok or not ws then
		warn("[dex-bridge] connect failed: " .. tostring(ws))
		return
	end
	local closed = false
	ws.OnMessage:Connect(function(raw)
		local okReply, reply = pcall(Core.dispatch, raw)
		if okReply then pcall(function() ws:Send(reply) end) end
	end)
	ws.OnClose:Connect(function() closed = true end)
	print("[dex-bridge] connected to " .. URL)
	while not closed do task.wait(0.5) end
	warn("[dex-bridge] disconnected")
end

task.spawn(function()
	print("[dex-bridge] starting, target " .. URL)
	while true do
		connectOnce()
		task.wait(RECONNECT_DELAY)
	end
end)
```

- [ ] **Step 2: Syntax-check the template with placeholders removed**

The file has intentional `__DEX_*` placeholders that aren't valid Luau alone, so it cannot be compiled standalone. Just confirm it reads (full parse happens in Task 9 once assembled). `lune` has no `-e/--eval` flag — run a tiny script file instead:
```bash
echo 'print(#require("@lune/fs").readFile("bridge/dex-bridge.luau"))' > tmp-check.luau
lune run tmp-check.luau
rm tmp-check.luau
```
Expected: prints a byte count (proves the file reads).

- [ ] **Step 3: Commit**

```bash
git add bridge/dex-bridge.luau
git commit -m "feat(bridge): WebSocket supervisor + env glue (assembled by server)"
```

---

## Task 9: server — bridge-loader.ts (assemble + inject)

**Files:**
- Create: `src/bridge-hub/bridge-loader.ts`, `test/bridge-loader.test.ts`

- [ ] **Step 1: Write the failing test `test/bridge-loader.test.ts`**

```ts
import { describe, it, expect } from "vitest";
import { assembleBridge } from "../src/bridge-hub/bridge-loader.js";

describe("assembleBridge", () => {
  it("inlines codec+core and substitutes port and token", () => {
    const out = assembleBridge(12345, "secret-token");
    // markers gone
    expect(out).not.toContain("__DEX_MAKECODEC__");
    expect(out).not.toContain("__DEX_MAKECORE__");
    expect(out).not.toContain("__DEX_PORT__");
    expect(out).not.toContain("__DEX_TOKEN__");
    // substitutions present
    expect(out).toContain("local PORT = 12345");
    expect(out).toContain('local TOKEN = "secret-token"');
    // factories inlined as IIFEs assigned to makeCodec/makeCore
    expect(out).toContain("local makeCodec = (function()");
    expect(out).toContain("local makeCore = (function()");
    // codec/core bodies are present (sentinel substrings)
    expect(out).toContain("Codec.encode");
    expect(out).toContain("Core.dispatch");
  });

  it("escapes a token containing a quote safely", () => {
    const out = assembleBridge(1, 'a"b');
    expect(out).toContain('local TOKEN = "a\\"b"');
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/bridge-loader.test.ts`
Expected: FAIL — module not found.

- [ ] **Step 3: Write `src/bridge-hub/bridge-loader.ts`**

```ts
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { dirname, join } from "node:path";

const HERE = dirname(fileURLToPath(import.meta.url));
// dist/bridge-hub -> repo root is two levels up; bridge/ ships alongside dist (see package.json "files")
const BRIDGE_DIR = join(HERE, "..", "..", "bridge");

function read(name: string): string {
  return readFileSync(join(BRIDGE_DIR, name), "utf8");
}

// Lua long-bracket-safe? We use a plain quoted string for the token; escape backslash and quote.
function luaQuote(value: string): string {
  return `"${value.replace(/\\/g, "\\\\").replace(/"/g, '\\"')}"`;
}

/** Assemble the single Luau payload the executor loads: codec+core inlined, port/token injected. */
export function assembleBridge(port: number, token: string): string {
  const codec = read("codec.luau");
  const core = read("core.luau");
  const glue = read("dex-bridge.luau");
  return glue
    .replace("__DEX_MAKECODEC__", `local makeCodec = (function()\n${codec}\nend)()`)
    .replace("__DEX_MAKECORE__", `local makeCore = (function()\n${core}\nend)()`)
    .replace("__DEX_PORT__", String(port))
    .replace('"__DEX_TOKEN__"', luaQuote(token));
}
```

> Note the token replacement targets the QUOTED placeholder `"__DEX_TOKEN__"` in the glue and replaces it with a freshly-quoted (escaped) Lua string, so a token with special chars can't break out. The default token is 32 hex chars (safe), but escaping is defense-in-depth.

> **Gotcha (must handle):** `dex-bridge.luau`'s header comment documents the markers and therefore contains the literal strings `__DEX_MAKECODEC__`/`__DEX_MAKECORE__`. A naive `String.replace("__DEX_MAKECODEC__", ...)` matches the COMMENT first and leaves the real (standalone-line) marker unreplaced → invalid assembled Luau. `assembleBridge` must (a) strip the marker-documentation comment block before substituting, and (b) match the standalone markers line-anchored (`/^__DEX_MAKECODEC__$/m`). The Task 9 Step 5 compile-check (`@lune/luau.load`) is what catches a regression here.

- [ ] **Step 4: Run to verify it passes**

Run: `npx vitest run test/bridge-loader.test.ts`
Expected: PASS (2 tests).

- [ ] **Step 5: Assembled-bridge parse check (compile-only, no execution)**

Guard that the assembled output is valid Luau (catches a broken glue/marker). The assembled bridge calls `WebSocket.connect`/`task.spawn` at bootstrap, which would error under lune — so we COMPILE without running, via `@lune/luau`'s `load` (returns a closure but does not call it). `lune` has no `-e` flag; use a script file.

```bash
npm run build
node -e "import('./dist/bridge-hub/bridge-loader.js').then(m=>require('fs').writeFileSync('tmp-bridge.luau', m.assembleBridge(8392,'tok')))"
echo 'local luau=require("@lune/luau"); local fs=require("@lune/fs"); luau.load(fs.readFile("tmp-bridge.luau")); print("assembled bridge parses OK")' > tmp-check.luau
lune run tmp-check.luau
rm tmp-check.luau tmp-bridge.luau
```
Expected: `assembled bridge parses OK` (a syntax error in the assembled file makes `luau.load` throw, failing the step). `@lune/luau.load` compiles + returns a function WITHOUT executing it, so no `WebSocket`/`task` access occurs.

- [ ] **Step 6: Commit**

```bash
git add src/bridge-hub/bridge-loader.ts test/bridge-loader.test.ts
git commit -m "feat(server): assemble+inject the Luau bridge payload"
```

---

## Task 10: server — http.Server + GET /bridge route

**Files:**
- Modify: `src/bridge-hub/ws-server.ts`
- Create: `test/bridge-route.test.ts`

The WS server currently owns its port directly. To also serve `/bridge`, create an `http.Server` with a request handler and pass it to `WebSocketServer({ server })`. All existing ws-server tests must still pass.

- [ ] **Step 1: Write the failing test `test/bridge-route.test.ts`**

```ts
import { describe, it, expect, afterEach } from "vitest";
import { BridgeHub } from "../src/bridge-hub/ws-server.js";
import type { DexConfig } from "../src/config.js";

const config: DexConfig = {
  port: 0, token: "tok", enableWrite: true, enableRemotes: true, enableRunLuau: true, rpcTimeoutMs: 2000
};

let hub: BridgeHub | undefined;
afterEach(async () => { await hub?.stop(); hub = undefined; });

describe("GET /bridge", () => {
  it("serves an assembled Luau payload with the token injected", async () => {
    hub = new BridgeHub(config);
    const port = await hub.start();
    const res = await fetch(`http://127.0.0.1:${port}/bridge`);
    expect(res.status).toBe(200);
    const body = await res.text();
    expect(body).toContain('local TOKEN = "tok"');
    expect(body).toContain(`local PORT = ${port}`); // the LIVE ephemeral port, not 0
    expect(body).toContain("Core.dispatch");
    expect(body).not.toContain("__DEX_TOKEN__");
  });

  it("404s an unknown path", async () => {
    hub = new BridgeHub(config);
    const port = await hub.start();
    const res = await fetch(`http://127.0.0.1:${port}/nope`);
    expect(res.status).toBe(404);
  });
});
```

- [ ] **Step 2: Run to verify it fails**

Run: `npx vitest run test/bridge-route.test.ts`
Expected: FAIL — `/bridge` returns nothing / connection behavior wrong.

- [ ] **Step 3: Modify `src/bridge-hub/ws-server.ts`** — replace the imports and `start()` only; leave `handleConnection`, `isConnected`, `request`, `stop` bodies intact except `stop()` must also close the http server.

Replace the top imports:
```ts
import { WebSocketServer, WebSocket, type RawData } from "ws";
import { createServer, type Server, type IncomingMessage, type ServerResponse } from "node:http";
import type { AddressInfo } from "node:net";
import type { DexConfig } from "../config.js";
import { RpcClient } from "./rpc.js";
import { assembleBridge } from "./bridge-loader.js";
```

Add a field next to `private wss?`:
```ts
  private http?: Server;
  private port = 0;
```

Replace `start()`:
```ts
  start(): Promise<number> {
    return new Promise((resolve) => {
      this.http = createServer((req, res) => this.handleHttp(req, res));
      this.wss = new WebSocketServer({
        server: this.http,
        verifyClient: (info, cb) => {
          const url = new URL(info.req.url ?? "", "ws://127.0.0.1");
          if (url.searchParams.get("token") === this.config.token) cb(true);
          else cb(false, 401, "invalid token");
        }
      });
      this.wss.on("connection", (ws) => this.handleConnection(ws));
      this.http.listen(this.config.port, "127.0.0.1", () => {
        this.port = (this.http!.address() as AddressInfo).port;
        resolve(this.port);
      });
    });
  }

  // GET /bridge -> the assembled Luau loader (localhost-only; bootstrap, no token required).
  private handleHttp(req: IncomingMessage, res: ServerResponse): void {
    const url = new URL(req.url ?? "", "http://127.0.0.1");
    if (req.method === "GET" && url.pathname === "/bridge") {
      // inject the LIVE listening port (handles ephemeral port:0; address() is set once listening)
      const livePort = (this.http?.address() as AddressInfo | null)?.port ?? this.port;
      const body = assembleBridge(livePort, this.config.token);
      res.writeHead(200, { "content-type": "text/plain; charset=utf-8" });
      res.end(body);
      return;
    }
    res.writeHead(404, { "content-type": "text/plain" });
    res.end("not found");
  }
```

> Note: `verifyClient` upgrade requests also hit the http server, but `ws` intercepts the `upgrade` event before `request`, so the WS handshake is unaffected by `handleHttp`. The WebSocket auth (token) is unchanged.

Update `stop()` to also close the http server:
```ts
  async stop(): Promise<void> {
    this.socket?.close();
    await new Promise<void>((resolve) => {
      if (!this.wss) return resolve();
      this.wss.close(() => resolve());
    });
    await new Promise<void>((resolve) => {
      if (!this.http) return resolve();
      this.http.close(() => resolve());
    });
  }
```

- [ ] **Step 4: Run the new test AND the existing ws-server test (must stay green)**

Run: `npx vitest run test/bridge-route.test.ts test/ws-server.test.ts`
Expected: BOTH pass. The ws-server token tests must still behave (bad token → connection rejected). If `verifyClient` no longer fires, confirm `{ server }` is used (it is) and `ws` attaches the upgrade handler to `this.http`.

- [ ] **Step 5: Full suite**

Run: `npm test`
Expected: all green (37 + new tests). If `bridge-loader` reads files at module load and the bridge files exist, no path issues. If a path error occurs (dist vs src), confirm `BRIDGE_DIR` resolves to repo-root `bridge/` from `dist/bridge-hub/` (`../../bridge`).

- [ ] **Step 6: Commit**

```bash
git add src/bridge-hub/ws-server.ts test/bridge-route.test.ts
git commit -m "feat(server): serve assembled bridge over GET /bridge"
```

---

## Task 11: server — startup banner with the loader one-liner

**Files:**
- Modify: `src/index.ts`

- [ ] **Step 1: Update the banner in `src/index.ts`**

Replace the three banner lines with:
```ts
  const bridgeUrl = `ws://127.0.0.1:${port}?token=${config.token}`;
  process.stderr.write(`[dex-mcp] WebSocket hub + bridge loader on http://127.0.0.1:${port}\n`);
  process.stderr.write(`[dex-mcp] In your executor, run:\n`);
  process.stderr.write(`[dex-mcp]   loadstring(game:HttpGet("http://127.0.0.1:${port}/bridge"))()\n`);
  process.stderr.write(`[dex-mcp] (WebSocket auth token: ${config.token})\n`);
  process.stderr.write(`[dex-mcp] API dump: ${dump ? "loaded" : "unavailable (bridge returns its curated property set)"}\n`);
  void bridgeUrl;
```
(Keep the rest of `main()` and the `getApiDump`/`Session`/`buildServer` wiring unchanged.)

- [ ] **Step 2: Build + smoke run**

Run: `npm run build`
Then: `DEX_MCP_PORT=18392 node dist/index.js </dev/null >stdout.log 2>stderr.log & P=$!; sleep 2; kill $P; echo "STDERR:"; cat stderr.log; echo "STDOUT:"; cat stdout.log; rm -f stdout.log stderr.log`
Expected: STDERR shows the `loadstring(game:HttpGet("http://127.0.0.1:18392/bridge"))()` line and the token; STDOUT empty.

Then verify the route actually serves while running:
```bash
DEX_MCP_PORT=18392 node dist/index.js >/dev/null 2>&1 & P=$!; sleep 1; curl -s http://127.0.0.1:18392/bridge | head -c 200; echo; kill $P
```
Expected: the first 200 chars of the assembled Luau payload (starts with `--!strict` / the glue header).

- [ ] **Step 3: Full suite + commit**

Run: `npm test` → all green.
```bash
git add src/index.ts
git commit -m "feat(server): print bridge loader one-liner on startup"
```

---

## Task 12: Manual executor smoke test (read side)

**Files:** none (manual verification; record results in the PR/commit message).

- [ ] **Step 1: Start the server** — `node dist/index.js` (note the printed port + loader line).
- [ ] **Step 2: In your executor** (Wave/Solara/Swift/Script-Ware/Krnl), join any place you own or a baseplate, and run the printed `loadstring(game:HttpGet("http://127.0.0.1:<port>/bridge"))()`.
- [ ] **Step 3: Confirm connection** — the executor console prints `[dex-bridge] connected to ws://...`; the server stderr shows a bridge connection.
- [ ] **Step 4: Drive read tools** via your MCP client (or a manual MCP call): `dex_status` (expect gameName/placeId/capabilities), `get_root` (ref 0 + services), `get_children` on Workspace, `get_properties` on a Part (expect tagged Vector3 Position etc.), `search "Part"`, `get_by_path game.Workspace`. 
- [ ] **Step 5: Verify shapes** — confirm replies parse and match the contract (bare arrays for children/search; tagged values for properties; `class` on Instance values). Record any mismatch as a bug and fix the corresponding handler, then re-run the lune suite.

Expected: all read tools return correct, parseable data against a real game. **Do not mark this task complete on assertion alone — it must actually run in an executor.**

---

## Task 13: Manual end-to-end (write / remotes / runLuau / spy)

**Files:** none (manual).

- [ ] **Step 1: set_property** — pick a Part, `set_property` its `Anchored`/`Transparency`/`Position` (tagged Vector3); confirm the change in-game.
- [ ] **Step 2: run_luau** — `run_luau "print('hi'); return 1+1"`; expect `{ output = "hi", returned = 2 }`.
- [ ] **Step 3: fire_remote / invoke_remote** — on a RemoteEvent/RemoteFunction in a place you own; confirm the server receives it / a result returns. (Use only your own game.)
- [ ] **Step 4: remote spy** — `remote_spy_start` (if your executor has `hookmetamethod`+`getrawmetatable`+`getnamecallmethod`+`newcclosure`), trigger a remote, `remote_spy_dump` → expect `{ entries: [{ remote, args, method }] }`. On an executor lacking the hooks, confirm `remote_spy_start` returns the `remote spy unsupported by this executor` error (graceful, no crash).
- [ ] **Step 5: reconnect** — stop and restart the server; confirm the bridge reconnects within ~3s without re-running the loader.

Expected: every power tool works against a real game, and the capability gate degrades gracefully. Record results.

---

## Task 14: Docs — bridge usage + guidelines

**Files:**
- Modify: `README.md`, `GUIDELINES.md`

- [ ] **Step 1: Add a "Bridge" section to `README.md`** (after the existing "The bridge" stub, replace it):

```markdown
## The bridge (Roblox side)

The Luau bridge runs inside a script executor and connects back to this server.

1. Start the server: `node dist/index.js`. It prints a loader line.
2. In your executor (in a game you own / are allowed to inspect), run:
   ```lua
   loadstring(game:HttpGet("http://127.0.0.1:<port>/bridge"))()
   ```
   The server injects the per-run auth token into the served script automatically.
3. The bridge connects over WebSocket and answers the MCP tools. It auto-reconnects if the server restarts.

The bridge is assembled on the fly from `bridge/codec.luau`, `bridge/core.luau`, and `bridge/dex-bridge.luau`. The codec and core are unit-tested with [lune](https://lune-ui.dev): `npm run test:bridge`.

### Executor requirements
- `WebSocket.connect` (UNC/sUNC standard). 
- `loadstring` for `run_luau`.
- `hookmetamethod`/`getrawmetatable`/`getnamecallmethod`/`newcclosure` for the remote spy (capability-gated — the bridge degrades gracefully without them).
```

- [ ] **Step 2: Append to `GUIDELINES.md`**:

```markdown

## Bridge scope
- The bridge runs in an executor on the user's machine and operates on games the user owns or is permitted to inspect.
- It includes no anti-cheat evasion or detection-avoidance; the `__namecall` remote spy is for inspecting your own game's traffic and is hard-gated on executor capabilities.
```

- [ ] **Step 3: Commit**

```bash
git add README.md GUIDELINES.md
git commit -m "docs: bridge usage, executor requirements, and scope"
```

---

## Self-Review

**1. Spec coverage** (against `2026-06-07-dex-mcp-design.md` §4/§6 + the frozen mock contract):
- Every RPC method (status, getRoot, getChildren, getProperties, setProperty, search, getSource, getByPath, fireRemote, invokeRemote, remoteSpyStart/Stop/Dump, runLuau): Tasks 5–7 ✓
- Envelope {id,ok,result|error} + unknown-method + malformed-frame + pcall wrapping: Task 5 dispatch ✓
- Bare arrays for getChildren/search, bare node for getByPath, `class` on Instance: Tasks 5/6 + Task 3 contract ✓
- Codec all tagged types incl CFrame 12-components + NaN/Inf guard + decode coercion: Tasks 1–2 ✓
- Ref tables weak `__mode` v/k, game=0, stale-ref exact wording: Task 4 ✓
- API-dump-driven propertyNames AND no-dump curated/`getproperties` fallback: Task 5 getProperties ✓
- Capability-gated remote spy, dump-time path resolution, no real-time push (server doesn't consume events): Task 7 ✓
- HTTP loader + token injection (resolved decision): Tasks 9–11 ✓
- §5 weak tables, §6 Luau codec, §3 bridge row — all implemented bridge-side ✓

**2. Placeholder scan:** The `__DEX_*` markers in `dex-bridge.luau` are INTENTIONAL (substituted by `bridge-loader.ts`), not plan placeholders; every code step has complete content. No TBD/TODO.

**3. Type/contract consistency:** `makeCodec(env)`, `makeCore(env)`, `Core.dispatch`, `Core.refFor/resolve/buildNode/dotPath/encodeInstance`, `Codec.encode(v, encodeInstance)`, `Codec.decode(v, valueType, current, resolve)` used consistently across Tasks 1–8. Reply envelope keys match `rpc.ts` (`id/ok/result/error`). Result shapes match the Task-extracted contract (bare arrays, `{ok=true}`, `{result}`, `{entries}`, `{className,properties}`, `{source}`, `{output,returned?}`). Error strings match the mock exactly (`stale ref <N>`, `instance has no readable source`, `path not found: <path>`, `unknown method <method>`) — `dispatch` strips Lua's `chunk:line:` position prefix and Task 5 asserts the exact strings via `==`. The `remote spy unsupported by this executor` string is bridge-chosen (the mock never errors `remoteSpyStart`) but is asserted exactly in Task 7.

**Known deviations from the original research sketches (intentional, recorded):**
1. Factory architecture (`makeCodec`/`makeCore` taking `env`) instead of one flat file — enables lune unit tests for codec+core+handlers, the user-chosen testing path.
2. Server-assembled HTTP loader instead of `_G.DEX_MCP` — the user-chosen launch UX; adds the `/bridge` route (Tasks 9–11).
3. `getChildren`/`search` return BARE arrays (NOT `{nodes,truncated}`) — required by the frozen contract; the truncation fix (review Issues 2/3) is explicitly deferred.

**Adversarial review applied:** a 5-dimension adversarial verification workflow reviewed this plan. It caught and fixed 4 criticals — the lune stub `EnumType=nil` bug (encode would emit `enum="nil"`), the non-existent `lune run -e` flag (replaced with script-file + `@lune/luau.load` compile-only checks), and the Lua `error()` position-prefix that would have broken the 34 server tests' exact-string comparison (now stripped in `dispatch`) — plus importants (search now honors `rootRef`/`maxDepth`; empty-`properties` map guarded; live port injection; invokeRemote encode test). The remaining real-executor-only behaviors (`tostring(EnumItem.EnumType)`, `WebSocket`, hooks, `loadstring`) are confirmed in Tasks 12–13.

---

## Execution Handoff

Plan complete and saved to `docs/superpowers/plans/2026-06-07-dex-mcp-bridge.md`. Two execution options:

1. **Subagent-Driven (recommended)** — a fresh subagent per task, with review between tasks. Note: Tasks 12–13 are MANUAL (real executor) and cannot be done by a subagent — they pause for the user.
2. **Inline Execution** — execute tasks in this session using executing-plans, batched with checkpoints.

This plan completes dex-mcp v1: the server (Plan 1, merged) + this Luau bridge make the tool actually usable against a real Roblox client.
