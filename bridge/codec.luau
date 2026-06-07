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

	return Codec
end
