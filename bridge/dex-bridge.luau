--!strict
-- DEX-MCP bridge glue. The server prepends codec.luau and core.luau as
-- `makeCodec`/`makeCore` factories and substitutes the markers below.
-- Markers (replaced by src/bridge-hub/bridge-loader.ts):
--   __DEX_MAKECODEC__  -> local makeCodec = (function() <codec.luau> end)()
--   __DEX_MAKECORE__   -> local makeCore  = (function() <core.luau>  end)()
--   __DEX_WS_BASE__    -> the WebSocket origin (ws://127.0.0.1:port or wss://host)
--   __DEX_TOKEN__      -> the shared token string

__DEX_MAKECODEC__
__DEX_MAKECORE__

local WS_BASE = "__DEX_WS_BASE__"
local TOKEN = "__DEX_TOKEN__"
local URL = WS_BASE .. "?token=" .. TOKEN
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
