-- UGV-02 throttle gears (ArduRover, SIYI UniFC 6 Pico).
-- Four gears cap forward/back power at 25 / 50 / 75 / 100 % (MOT_THR_MAX). Steering is not changed.
-- Two remote buttons change gear:
--   the channel with RCx_OPTION = 300 (Scripting1) shifts up,
--   the channel with RCx_OPTION = 301 (Scripting2) shifts down.
-- Every boot starts in gear 1. MOT_THR_MAX is changed in memory only, never saved, so if this script
-- is not running the vehicle uses the stored value (100 %).
-- Install: microSD card in the board, copy to APM/scripts/, SCR_ENABLE = 1, reboot.

local GEARS = { 25, 50, 75, 100 }
local UP_OPTION = 300
local DOWN_OPTION = 301
-- How the remote buttons behave, measured on the remote:
--   'momentary': the channel goes high while the button is held and back low on release
--   'toggle':    each press flips the channel between low and high
-- UGV-02's SIYI remote buttons latch: ch11 rests at 1950, ch12 at 1050, and each press flips them (seen 29 Oct).
local BUTTON_MODE = 'toggle'
local PERIOD_MS = 50

local gear = 1
local last = {}

local function apply()
  param:set('MOT_THR_MAX', GEARS[gear])
  gcs:send_text(6, string.format('Gear %d/%d: %d%%', gear, #GEARS, GEARS[gear]))
end

-- True once for each press of the button on this RC option.
local function pressed(option)
  local ch = rc:find_channel_for_option(option)
  if not ch then
    return false
  end
  local pos = ch:get_aux_switch_pos() -- 0 low, 1 middle, 2 high
  local prev = last[option]
  last[option] = pos
  if prev == nil then
    return false -- first reading after boot or after the remote reconnects
  end
  if BUTTON_MODE == 'toggle' then
    return pos ~= prev
  end
  return pos == 2 and prev ~= 2
end

local function update()
  if not rc:has_valid_input() then
    last = {} -- remote lost: ignore the first reading when it comes back
    return update, PERIOD_MS
  end
  if pressed(UP_OPTION) and gear < #GEARS then
    gear = gear + 1
    apply()
  end
  if pressed(DOWN_OPTION) and gear > 1 then
    gear = gear - 1
    apply()
  end
  return update, PERIOD_MS
end

apply()
return update, PERIOD_MS
