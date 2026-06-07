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
