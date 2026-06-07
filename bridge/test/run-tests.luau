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
