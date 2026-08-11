(function attachWalkplayKt1213Toolkit(global) {
  "use strict";

  if (!global) {
    return;
  }

  // Extracted from the WalkPlay web app's KT1213 EQ write path.
  // This focuses on the stable EQ packet flow; upstream mic helpers are still
  // incomplete in their own frontend bundle and are intentionally not mirrored here.

  const REPORT_ID = 87;
  const WALKPLAY_VENDOR_IDS = [0x3302, 0x0762, 0x35d8, 0x2fc6, 0x0104, 0xb445, 0x0661, 0x0666, 0x0d8c];
  const BANK_ROTATION = [0, 64, 128, 192];
  const FILTER_TYPE_CODES = {
    PK: 0,
    LP: 1,
    HP: 2,
    LS: 3,
    HS: 4
  };
  const PRESET_LAYOUTS = {
    bands5: [200, 500, 2500, 5000, 10000],
    bands6: [200, 500, 1000, 2500, 5000, 10000],
    bands8: [50, 200, 500, 1000, 2500, 5000, 10000, 15000],
    bands10: [31, 62, 125, 250, 500, 1000, 2000, 4000, 8000, 16000],
    bands15: [31, 62, 125, 250, 500, 1000, 2000, 4000, 6000, 8000, 9000, 10000, 11000, 13000, 16000]
  };
  const DEFAULT_LAYOUT = PRESET_LAYOUTS.bands8.slice();
  const internalState = {
    device: null
  };

  function clamp(value, min, max) {
    return Math.min(Math.max(value, min), max);
  }

  function trunc(value) {
    return value < 0 ? Math.ceil(value) : Math.floor(value);
  }

  function toUint8(value) {
    return Number(value) & 0xff;
  }

  function encodeSigned16(value) {
    const normalized = trunc(Number(value) || 0);
    return [toUint8(normalized), toUint8(normalized >> 8)];
  }

  function encodeSigned32(value) {
    const normalized = trunc(Number(value) || 0);
    return [
      toUint8(normalized),
      toUint8(normalized >> 8),
      toUint8(normalized >> 16),
      toUint8(normalized >> 24)
    ];
  }

  function crc16Modbus(bytes) {
    let crc = 0;
    const view = bytes instanceof Uint8Array ? bytes : new Uint8Array(bytes || []);
    for (let index = 0; index < view.length; index += 1) {
      crc ^= view[index];
      for (let bit = 0; bit < 8; bit += 1) {
        const lsb = crc & 1;
        crc >>= 1;
        if (lsb) {
          crc ^= 0xa001;
        }
      }
    }
    return crc & 0xffff;
  }

  function withCrc(packet) {
    const payload = packet instanceof Uint8Array ? packet : new Uint8Array(packet || []);
    const crc = crc16Modbus(payload);
    const out = new Uint8Array(payload.length + 2);
    out.set(payload, 0);
    out[payload.length] = crc & 0xff;
    out[payload.length + 1] = (crc >> 8) & 0xff;
    return out;
  }

  function normalizeFilterType(type) {
    const upper = String(type || "PK").trim().toUpperCase();
    if (upper === "PEAK" || upper === "PEAKING") {
      return "PK";
    }
    if (upper === "LOWSHELF" || upper === "LOW_SHELF" || upper === "LSQ") {
      return "LS";
    }
    if (upper === "HIGHSHELF" || upper === "HIGH_SHELF" || upper === "HSQ") {
      return "HS";
    }
    return Object.prototype.hasOwnProperty.call(FILTER_TYPE_CODES, upper) ? upper : "PK";
  }

  function getLayout(layout) {
    if (Array.isArray(layout) && layout.length) {
      return layout.slice();
    }
    if (typeof layout === "string" && Object.prototype.hasOwnProperty.call(PRESET_LAYOUTS, layout)) {
      return PRESET_LAYOUTS[layout].slice();
    }
    return DEFAULT_LAYOUT.slice();
  }

  function normalizeFilter(filter, index, fallbackFreq) {
    const source = filter || {};
    return {
      enabled: source.enabled !== false && source.disabled !== true,
      freq: clamp(Math.round(Number(source.freq) || fallbackFreq || 1000), 20, 20000),
      q: clamp(Number(source.q) || 0.75, 0.2, 10),
      gain: clamp(Number(source.gain) || 0, -24, 24),
      type: normalizeFilterType(source.type),
      index
    };
  }

  function buildEqProfile(filters, options) {
    const config = options || {};
    const layout = getLayout(config.layout);
    const rawFilters = Array.isArray(filters) ? filters : [];
    const bandCount = config.bandCount || layout.length || rawFilters.length || DEFAULT_LAYOUT.length;
    const normalizedFilters = [];

    for (let index = 0; index < bandCount; index += 1) {
      normalizedFilters.push(normalizeFilter(rawFilters[index], index, layout[index] || layout[layout.length - 1] || 1000));
    }

    return {
      reportId: REPORT_ID,
      bandCount,
      source: config.source || "app",
      preamp: Number(config.preamp) || 0,
      filters: normalizedFilters,
      freqs: normalizedFilters.map((filter) => filter.freq),
      qs: normalizedFilters.map((filter) => filter.q),
      gains: normalizedFilters.map((filter) => filter.gain),
      filterTypes: normalizedFilters.map((filter) => FILTER_TYPE_CODES[filter.type]),
      enabled: normalizedFilters.map((filter) => filter.enabled !== false)
    };
  }

  function fromAppFilters(filters, options) {
    return buildEqProfile(filters, options);
  }

  function buildRegisterWritePacket(rotationIndex, registerOffset, registerLength, dataBytes) {
    const packet = new Uint8Array(5 + registerLength);
    packet[0] = 63;
    packet[1] = 90;
    packet[2] = 165;
    packet[3] = BANK_ROTATION[rotationIndex % BANK_ROTATION.length] + 1;
    packet[4] = registerLength;
    packet[5] = 70;
    packet[6] = 128;
    packet[7] = toUint8(registerOffset);
    packet[8] = 0;
    for (let index = 0; index < dataBytes.length; index += 1) {
      packet[9 + index] = toUint8(dataBytes[index]);
    }
    return packet;
  }

  function buildEqPackets(profile, options) {
    const config = options || {};
    const normalizedProfile = Array.isArray(profile) ? buildEqProfile(profile, config) : buildEqProfile(profile && profile.filters ? profile.filters : [], profile || config);
    const packets = [];
    let rotationIndex = 0;

    for (let filterIndex = 0; filterIndex < normalizedProfile.filters.length; filterIndex += 1) {
      const filter = normalizedProfile.filters[filterIndex];
      const baseOffset = 10 * filterIndex;
      const encodedFreq = encodeSigned32(trunc(filter.freq / 2));
      const encodedQ = encodeSigned16(trunc(filter.q * 1000));
      const encodedGain = encodeSigned16(trunc(filter.gain * 10));
      const filterType = FILTER_TYPE_CODES[filter.type];
      const enabledValue = filter.enabled !== false ? 1 : 0;

      packets.push(buildRegisterWritePacket(rotationIndex, baseOffset + 0, 8, encodedFreq));
      rotationIndex += 1;
      packets.push(buildRegisterWritePacket(rotationIndex, baseOffset + 4, 6, encodedQ));
      rotationIndex += 1;
      packets.push(buildRegisterWritePacket(rotationIndex, baseOffset + 6, 6, encodedGain));
      rotationIndex += 1;
      packets.push(buildRegisterWritePacket(rotationIndex, baseOffset + 8, 5, [filterType]));
      rotationIndex += 1;
      packets.push(buildRegisterWritePacket(rotationIndex, baseOffset + 9, 5, [enabledValue]));
      rotationIndex += 1;
    }

    if (config.includeCommitPacket) {
      packets.push(buildCommitPacket());
    }

    if (config.appendCrc) {
      return packets.map((packet) => withCrc(packet));
    }

    return packets;
  }

  function buildCommitPacket() {
    return new Uint8Array([63, 90, 165, 129, 6, 128, 0, 0, 0, 0, 0, 0, 0]);
  }

  async function connect(device) {
    const target = device || internalState.device;
    if (!target) {
      throw new Error("No WalkPlay HID device selected.");
    }
    if (!target.opened) {
      await target.open();
    }
    internalState.device = target;
    return target;
  }

  async function requestDevice() {
    if (!navigator.hid || typeof navigator.hid.requestDevice !== "function") {
      throw new Error("WebHID is not supported in this browser.");
    }
    const filters = WALKPLAY_VENDOR_IDS.map((vendorId) => ({ vendorId }));
    const devices = await navigator.hid.requestDevice({ filters });
    if (!devices || !devices.length) {
      throw new Error("No WalkPlay device was selected.");
    }
    return connect(devices[0]);
  }

  async function reconnectGrantedDevice() {
    if (!navigator.hid || typeof navigator.hid.getDevices !== "function") {
      throw new Error("WebHID is not supported in this browser.");
    }
    const devices = await navigator.hid.getDevices();
    const match = devices.find((device) => WALKPLAY_VENDOR_IDS.includes(device.vendorId));
    if (!match) {
      throw new Error("No previously granted WalkPlay device was found.");
    }
    return connect(match);
  }

  async function disconnect() {
    if (internalState.device && internalState.device.opened) {
      await internalState.device.close();
    }
    internalState.device = null;
  }

  function getConnectedDevice() {
    return internalState.device;
  }

  async function sendPacket(device, packet) {
    const target = device || internalState.device;
    if (!target) {
      throw new Error("WalkPlay device is not connected.");
    }
    await connect(target);
    await target.sendReport(REPORT_ID, withCrc(packet));
  }

  async function writeEqProfile(profile, options) {
    const config = Object.assign({ includeCommitPacket: true }, options || {});
    const target = await connect(config.device || internalState.device || null);
    const packets = buildEqPackets(profile, config);
    for (let index = 0; index < packets.length; index += 1) {
      await sendPacket(target, packets[index]);
      if (config.packetDelayMs > 0) {
        await new Promise((resolve) => setTimeout(resolve, config.packetDelayMs));
      }
    }
    return {
      device: target,
      packetCount: packets.length,
      profile: Array.isArray(profile) ? buildEqProfile(profile, config) : buildEqProfile(profile && profile.filters ? profile.filters : [], profile || config)
    };
  }

  global.walkplayKt1213Toolkit = {
    REPORT_ID,
    WALKPLAY_VENDOR_IDS: WALKPLAY_VENDOR_IDS.slice(),
    FILTER_TYPE_CODES: Object.assign({}, FILTER_TYPE_CODES),
    PRESET_LAYOUTS,
    requestDevice,
    reconnectGrantedDevice,
    connect,
    disconnect,
    getConnectedDevice,
    buildEqProfile,
    fromAppFilters,
    buildEqPackets,
    buildCommitPacket,
    writeEqProfile,
    withCrc
  };
})(typeof window !== "undefined" ? window : globalThis);
