(function () {
  if (window.initializeDeviceEqPlugin && window.DevicePeqBundle) {
    return;
  }

  window.DevicePeqBundle = window.DevicePeqBundle || {};

// ==== fiioUsbHidHandler.js ====
const fiioUsbHID = (() => {
//
// Copyright 2024 : Pragmatic Audio
//
// Define the shared logic for JadeAudio / SnowSky / FiiO devices - Each manufacturer will have slightly
// different code so best to each have a separate 'module'

const PEQ_FILTER_COUNT = 0x18; // 24 in hex
const PEQ_GLOBAL_GAIN = 0x17; // 23 in hex
const PEQ_FILTER_PARAMS = 0x15; // 21 in hex
const PEQ_PRESET_SWITCH = 0x16; // 22 in hex
const PEQ_SAVE_TO_DEVICE = 0x19; // 25 in hex
const PEQ_RESET_DEVICE = 0x1B; // 27 in hex
const PEQ_RESET_ALL = 0x1C; // 28 in hex

// Note these have different headers
const PEQ_FIRMWARE_VERSION = 0x0B; // 11 in hex
const PEQ_NAME_DEVICE = 0x30; // 48 in hex

const SET_HEADER1 = 0xAA;
const SET_HEADER2 = 0x0A;
const GET_HEADER1 = 0xBB;
const GET_HEADER2 = 0x0B;
const END_HEADERS = 0xEE;

const fiioUsbHID = (function () {

  const getCurrentSlot = async (deviceDetails) => {
    var device = deviceDetails.rawDevice;
    var reportId = getFiioReportId(deviceDetails);
    try {
      let currentSlot = -99;

      device.oninputreport = async (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: getCurrentSlot() onInputReport received data:`, data);
        if (data[0] === GET_HEADER1 && data[1] === GET_HEADER2) {
          switch (data[4]) {
            case PEQ_PRESET_SWITCH:
              currentSlot = handleEqPreset(data, deviceDetails);
              break;
            default:
              console.log("USB Device PEQ: Unhandled data type:", data[4], data);
          }
        }
      };

      await getPresetPeq(device, reportId);

      // Wait at most 10 seconds for filters to be populated
      const result = await waitForFilters(() => {
        return currentSlot > -99
      }, device, 10000, (device) => (
        currentSlot
      ));

      return result;
    } catch (error) {
      console.error("Failed to pull data from FiiO Device:", error);
      throw error;
    }
  };

  const pushToDevice = async (deviceDetails, slot, preamp_gain, filters) => {
    try {
      var device = deviceDetails.rawDevice;
      var reportId = getFiioReportId(deviceDetails);

      // FiiO devices will automatically cut the max SPL by the maxGain (typically -12)
      // So, we can safely apply a +12 gain - the larged preamp_gain needed
      // .e.g. if we need to +5dB for a filter then we can still make the globalGain 7dB
      await setGlobalGain(device, deviceDetails.modelConfig.maxGain + preamp_gain, reportId);
      const maxFilters = deviceDetails.modelConfig.maxFilters;
      const maxFiltersToUse = Math.min(filters.length, maxFilters);
      await setPeqCounter(device, maxFiltersToUse, reportId);
      await new Promise(resolve => setTimeout(resolve, 100)); // Added 100ms delay

      for (let filterIdx = 0; filterIdx < maxFiltersToUse; filterIdx++) {
        const filter = filters[filterIdx];
        var gain = 0;   // If disabled we still need to reset to 0 gain as previous gain value will
        // still be active
        if (!filter.disabled) {
          gain = filter.gain;
        }
        await setPeqParams(device, filterIdx, filter.freq, gain, filter.q, convertFromFilterType(filter.type), reportId);
      }
      await new Promise(resolve => setTimeout(resolve, 100)); // Added 100ms delay

      saveToDevice(device, slot, reportId);

      console.log("PEQ filters pushed successfully.");

      if (deviceDetails.modelConfig.disconnectOnSave) {
        return true;    // Disconnect
      }
      return false;

    } catch (error) {
      console.error("Failed to push data to FiiO Device:", error);
      throw error;
    }
  };

  const pullFromDevice = async (deviceDetails, slot) => {
    try {
      const filters = [];
      let peqCount = 0;
      let globalGain = 0;
      let currentSlot = 0;
      var device = deviceDetails.rawDevice;
      var reportId = getFiioReportId(deviceDetails);

      device.oninputreport = async (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: pullFromDevice() onInputReport received data:`, data);
        if (data[0] === GET_HEADER1 && data[1] === GET_HEADER2) {
          switch (data[4]) {
            case PEQ_FILTER_COUNT:
              peqCount = handlePeqCounter(data, device, reportId);
              break;
            case PEQ_FILTER_PARAMS:
              handlePeqParams(data, device, filters);
              break;
            case PEQ_GLOBAL_GAIN:
              globalGain = handleGain(data[6], data[7]);
              console.log(`USB Device PEQ: Global gain received: ${globalGain}dB`);
              break;
            case PEQ_PRESET_SWITCH:
              currentSlot = handleEqPreset(data, deviceDetails);
              break;
            case PEQ_SAVE_TO_DEVICE:
              savedEQ(data, device);
              break;
            default:
              console.log("USB Device PEQ: Unhandled data type:", data[4], data);
          }
        }
      };

      await getPresetPeq(device, reportId);
      await getPeqCounter(device, reportId);
      await getGlobalGain(device, reportId);

      // Wait at most 10 seconds for filters to be populated
      const result = await waitForFilters(() => {
        return filters.length == peqCount
      }, device, 10000, (device) => ({
        filters: filters,
        globalGain: globalGain
      }));

      return result;
    } catch (error) {
      console.error("Failed to pull data from FiiO Device:", error);
      throw error;
    }
  }

  const enablePEQ = async (deviceDetails, enable, slotId) => {

    var device = deviceDetails.rawDevice
    var reportId = getFiioReportId(deviceDetails);

    if (enable) {   // take the slotId we are given and switch to it
      await setPresetPeq(device, slotId, reportId);
    } else {
      await setPresetPeq(device, deviceDetails.modelConfig.maxFilters, reportId);
    }
  }
  return {
    pushToDevice,
    pullFromDevice,
    getCurrentSlot,
    enablePEQ
  };
})();


// Private Helper Functions

/**
 * Gets the appropriate reportId for a FiiO device based on its product name or modelConfig.
 * @param {Object} device - The device object.
 * @param {Object} [deviceDetails] - Optional deviceDetails object containing modelConfig.
 * @returns {number} - The reportId to use for the device.
 */
function getFiioReportId(deviceDetails) {
  // If deviceDetails is provided and has a modelConfig with reportId, use that
  if (deviceDetails && deviceDetails.modelConfig && deviceDetails.modelConfig.reportId !== undefined) {
    console.log(`Using reportId ${deviceDetails.modelConfig.reportId} from modelConfig for ${deviceDetails.model || "unknown device"}`);
    return deviceDetails.modelConfig.reportId;
  }

  // Default reportId for FiiO devices is 7
  console.log(`Using default reportId 7 for ${deviceDetails.model || "unknown device"}`);
  return 7;
}

async function setPeqParams(device, filterIndex, fc, gain, q, filterType, reportId) {
  const [frequencyLow, frequencyHigh] = splitUnsignedValue(fc);
  const [gainLow, gainHigh] = fiioGainBytesFromValue(gain);
  const qFactorValue = Math.round(q * 100);
  const [qFactorLow, qFactorHigh] = splitUnsignedValue(qFactorValue);

  const packet = [
    SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 8,
    filterIndex, gainLow, gainHigh,
    frequencyLow, frequencyHigh,
    qFactorLow, qFactorHigh,
    filterType, 0, END_HEADERS
  ];

  const data = new Uint8Array(packet);
  console.log(`USB Device PEQ: setPeqParams() sending filter ${filterIndex} - Freq: ${fc}Hz, Gain: ${gain}dB, Q: ${q}, Type: ${filterType}`, data);
  await device.sendReport(reportId, data);
}

async function setPresetPeq(device, presetId, reportId) { // Default to 0 if not specified
  const packet = [
    SET_HEADER1, SET_HEADER2, 0, 0, PEQ_PRESET_SWITCH, 1,
    presetId, 0, END_HEADERS
  ];

  const data = new Uint8Array(packet);
  console.log(`USB Device PEQ: setPresetPeq() switching to preset ${presetId}`, data);
  await device.sendReport(reportId, data);
}

async function setGlobalGain(device, gain, reportId) {
  const globalGain = Math.round(gain * 10);
  const gainBytes = toBytePair(globalGain);

  const packet = [
    SET_HEADER1, SET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 2,
    gainBytes[1], gainBytes[0], 0, END_HEADERS
  ];

  const data = new Uint8Array(packet);
  console.log(`USB Device PEQ: setGlobalGain() setting global gain to ${gain}dB`, data);
  await device.sendReport(reportId, data);
}

async function setPeqCounter(device, counter, reportId) {
  const packet = [
    SET_HEADER1, SET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 1,
    counter, 0, END_HEADERS
  ];

  const data = new Uint8Array(packet);
  console.log(`USB Device PEQ: setPeqCounter() setting filter count to ${counter}`, data);
  await device.sendReport(reportId, data);
}

function convertFromFilterType(filterType) {
  const mapping = {"PK": 0, "LSQ": 1, "HSQ": 2};
  return mapping[filterType] !== undefined ? mapping[filterType] : 0;
}

function convertToFilterType(datum) {
  switch (datum) {
    case 0:
      return "PK";
    case 1:
      return "LSQ";
    case 2:
      return "HSQ";
    default:
      return "PK";
  }
}

function toBytePair(value) {
  return [
    value & 0xFF,
    (value & 0xFF00) >> 8
  ];
}

function splitSignedValue(value) {
  const signedValue = value < 0 ? value + 65536 : value;
  return [
    (signedValue >> 8) & 0xFF,
    signedValue & 0xFF
  ];
}

function splitUnsignedValue(value) {
  return [
    (value >> 8) & 0xFF,
    value & 0xFF
  ];
}

function combineBytes(lowByte, highByte) {
  return (lowByte << 8) | highByte;
}

function getGlobalGain(device, reportId) {
  const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_GLOBAL_GAIN, 0, 0, END_HEADERS];
  const data = new Uint8Array(packet);
  console.log("getGlobalGain() Send data:", data);
  device.sendReport(reportId, data);
}

function getPeqCounter(device, reportId) {
  const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_COUNT, 0, 0, END_HEADERS];
  const data = new Uint8Array(packet);
  console.log("getPeqCounter() Send data:", data);
  device.sendReport(reportId, data);
}

function getPeqParams(device, filterIndex, reportId) {
  const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_FILTER_PARAMS, 1, filterIndex, 0, END_HEADERS];
  const data = new Uint8Array(packet);
  console.log("getPeqParams() Send data:", data);
  device.sendReport(reportId, data);
}

function getPresetPeq(device, reportId) {
  const packet = [GET_HEADER1, GET_HEADER2, 0, 0, PEQ_PRESET_SWITCH, 0, 0, END_HEADERS];
  const data = new Uint8Array(packet);
  console.log("getPresetPeq() Send data:", data);
  device.sendReport(reportId, data);
}

function saveToDevice(device, slotId, reportId) {
  const packet = [SET_HEADER1, SET_HEADER2, 0, 0, PEQ_SAVE_TO_DEVICE, 1, slotId, 0, END_HEADERS];
  const data = new Uint8Array(packet);
  console.log(`USB Device PEQ: saveToDevice() using reportId ${reportId} for slot ${slotId}`, data);
  device.sendReport(reportId, data);
}

function handlePeqCounter(data, device, reportId) {
  let peqCount = data[6];
  console.log("***********oninputreport peq counter=", peqCount);
  if (peqCount > 0) {
    processPeqCount(device, peqCount, reportId);
  }
  return peqCount;
}

function processPeqCount(device, peqCount, reportId) {
  console.log("PEQ Counter:", peqCount);

  // Fetch individual PEQ settings based on count
  for (let i = 0; i < peqCount; i++) {
    getPeqParams(device, i, reportId);
  }
}

function handlePeqParams(data, device, filters) {
  const filter = data[6];
  const gain = handleGain(data[7], data[8]);
  const frequency = combineBytes(data[9], data[10]);
  const qFactor = (combineBytes(data[11], data[12])) / 100 || 1;
  const filterType = convertToFilterType(data[13]);

  console.log(`Filter ${filter}: Gain=${gain}, Frequency=${frequency}, Q=${qFactor}, Type=${filterType}`);

  filters[filter] = {
    type: filterType,
    freq: frequency,
    q: qFactor,
    gain: gain,
    disabled: (gain || frequency || qFactor) ? false : true // Disable filter if 0 value found
  };
}


function handleGain(lowByte, highByte) {
  let r = combineBytes(lowByte, highByte);
  const gain = r & 32768 ? (r = (r ^ 65535) + 1, -r / 10) : r / 10;
  return gain;
}

function fiioGainBytesFromValue(e) {
  let t = e * 10;
  t < 0 && (t = (Math.abs(t) ^ 65535) + 1);
  const r = t >> 8 & 255,
    n = t & 255;
  return [r, n]
}

function handleEqPreset(data, deviceDetails) {
  const presetId = data[6];
  console.log("EQ Preset ID:", presetId);

  if (presetId === deviceDetails.modelConfig.disabledPresetId) {
    return -1;      // with JA11 slot 4 == Off
  }
  // Handle preset switch if necessary
  return presetId;
}

function savedEQ(data, device) {
  const slotId = data[6];
  console.log("EQ Slot ID:", slotId);
  // Handle slot enablement if necessary
}


// Utility function to wait for a condition or timeout
function waitForFilters(condition, device, timeout, callback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!condition()) {
        console.warn("Timeout reached before data returned?");
        reject(callback(device));
      } else {
        resolve(callback(device));
      }
    }, timeout);

    // Check every 100 milliseconds if everything is ready based on condition method !!
    const interval = setInterval(() => {
      if (condition()) {
        clearTimeout(timer);
        clearInterval(interval);
        resolve(callback(device));
      }
    }, 100);
  });
}
  return fiioUsbHID;
})();

// ==== walkplayHidHandler.js ====
const walkplayUsbHID = (() => {
//
// Copyright 2024 : Pragmatic Audio
//
// Define the shared logic for Walkplay devices
//
// Many thanks to ma0shu for providing a dump

const walkplayUsbHID = (function () {
  const REPORT_ID = 0x4B;
  const ALT_REPORT_ID = 0x3C;
  const READ = 0x80;
  const WRITE = 0x01;
  const END = 0x00;
  const CMD = {
    PEQ_VALUES: 0x09,
    VERSION: 0x0C,
    TEMP_WRITE: 0x0A,
    FLASH_EQ: 0x01,
    GET_SLOT: 0x0F,
    GLOBAL_GAIN: 0x03,
  };

  const DEFAULT_FILTER_COUNT = 8;

  const getCurrentSlot = async (deviceDetails) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error("Device not connected.");

    // Get the version number first
    await sendReport(device, REPORT_ID, [READ, CMD.VERSION, END]);
    var response = await waitForResponse(device);
    const versionBytes = response.slice(3, 6);
    const version = String.fromCharCode(...versionBytes);

    console.log("USB Device PEQ: Walkplay firmware version:", version);
    const versionNumber = parseFloat(version);

    if (isNaN(versionNumber)) {
      console.warn("Could not parse firmware version:", versionNumber);
      deviceDetails.version = null;
      return;
    }

    // Save version number to deviceDetails
    deviceDetails.version = versionNumber;

    console.log("Fetching current EQ slot...");

    await sendReport(device, REPORT_ID, [READ, CMD.PEQ_VALUES, END]);
    response = await waitForResponse(device);
    const slot = response ? response[35] : -1;

    console.log("Walkplay current EQ slot:", slot);
    return slot;
  };

  // Push PEQ settings to Walkplay device
  const pushToDevice = async (deviceDetails, slot, globalGain, filtersToWrite) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error("Device not connected.");
    console.log("Pushing PEQ settings...");
    if (typeof slot === "string" )  // Convert from string
      slot = parseInt(slot, 10);

    const useAltReport = false;

    for (let i = 0; i < filtersToWrite.length; i++) {
      const filter = filtersToWrite[i];
      const bArr = computeIIRFilter(i, filter.freq, filter.gain, filter.q);

      const packet = [
        WRITE, CMD.PEQ_VALUES, 0x18, 0x00, i, 0x00, 0x00,
        ...bArr,
        ...convertToByteArray(filter.freq, 2),
        ...convertToByteArray(Math.round(filter.q * 256), 2),
        ...convertToByteArray(Math.round(filter.gain * 256), 2),
        convertFromFilterType(filter.type),
        0x00,
        (deviceDetails.modelConfig && typeof deviceDetails.modelConfig.defaultIndex !== 'undefined') ? deviceDetails.modelConfig.defaultIndex : slot,
        END
      ];

      await sendReport(device, useAltReport ? ALT_REPORT_ID : REPORT_ID, packet);
    }

    if (deviceDetails.modelConfig && typeof deviceDetails.modelConfig.autoGlobalGain !== 'undefined') {
      // If the walkplay device auto calculates global gain we can leave the global gain as it was
      if (!deviceDetails.modelConfig.autoGlobalGain) {
        // Write the global gain
        await writeGlobalGain(device, globalGain);
        console.log(`USB Device PEQ: Walkplay set global gain to ${globalGain}`);
      }
    }

    await sendReport(device, REPORT_ID, [WRITE, CMD.TEMP_WRITE, 0x04, 0x00, 0x00, 0xFF, 0xFF, END]);
    await sendReport(device, REPORT_ID, [WRITE, CMD.FLASH_EQ, 0x01, END]);

    console.log("PEQ filters successfully pushed to Walkplay device.");
  };

  function convertFromFilterType(filterType) {
    const mapping = {"PK": 2, "LSQ": 1, "HSQ": 3};
    return mapping[filterType] !== undefined ? mapping[filterType] : 2;
  }

  const pullFromDevice = async (deviceDetails, slot = -1) => {
    const device = deviceDetails.rawDevice;
    if (!device) throw new Error("Device not connected.");

    const filters = [];
    let currentSlot = -1;

    device.oninputreport = async (event) => {
      const data = new Uint8Array(event.data.buffer);
      console.log(`USB Device PEQ: Walkplay pullFromDevice onInputReport received data:`, data);

      if (data.length >= 32) {
        const filter = parseFilterPacket(data);
        console.log(`USB Device PEQ: Walkplay parsed filter ${filter.filterIndex}:`, filter);
        filters[filter.filterIndex] = filter;
      }

      if (data.length >= 37) {
        currentSlot = data[35];
        console.log(`USB Device PEQ: Walkplay parsed current slot: ${currentSlot}`);
      }
    };

    // Send requests for each filter with increased delay
    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      await sendReport(device, REPORT_ID, [READ, CMD.PEQ_VALUES, 0x00, 0x00, i, END]);
      await delay(50); // Increased delay between requests
    }

    // Check for missing filters after initial requests
    await delay(100); // Wait a bit after sending all requests

    // Wait for filters with increased timeout
    const result = await waitForFilters(() => {
      return filters.filter(f => f !== undefined).length === deviceDetails.modelConfig.maxFilters;
    }, device, 10000, () => ({  // Increased timeout to 15 seconds
      filters,
      globalGain: 0, // Will be updated after waiting for filters
      currentSlot,
      deviceDetails: deviceDetails.modelConfig,
    }));

    device.oninputreport = null;  // Stop listening on this callback for now


    // Read global gain after waiting for filters
    let globalGain = 0;
    try {
      globalGain = await readGlobalGain(device);
      console.log(`USB Device PEQ: Walkplay read global gain: ${globalGain}dB`);
      // Update the result with the global gain
      result.globalGain = globalGain;
    } catch (error) {
      console.warn(`USB Device PEQ: Walkplay failed to read global gain: ${error}`);
    }

    console.log("Pulled PEQ filters from Walkplay:", result);
    return result;
  };

  function parseFilterPacket(packet) {
    if (packet.length < 32) {
      throw new Error("Packet too short to contain filter data.");
    }

    const filterIndex = packet[4];

    // Frequency (little-endian 16-bit)
    const freq = packet[27] | (packet[28] << 8);

    // Q factor (8.8 fixed-point)
    const qRaw = packet[29] | (packet[30] << 8);
    const q = Math.round((qRaw / 256) * 100) / 100;

    // Gain (8.8 fixed-point signed)
    let gainRaw = packet[31] | (packet[32] << 8);
    if (gainRaw > 32767) gainRaw -= 65536;
    const gain = Math.round((gainRaw / 256) * 100) / 100;

    // Filter type a??
    const type = convertToFilterType(packet[33]);

    return {
      filterIndex,
      freq,
      q,
      gain,
      type,
      disabled: !(freq || q || gain)
    };
  }

  function convertToFilterType(byte) {
    switch (byte) {
      case 1: return "LSQ"; // Low Shelf (if seen in future captures)
      case 2: return "PK"; // Peaking
      case 3: return "HSQ"; // High Shelf (future-proof)
      default: return "PK";
    }
  }
  const enablePEQ = async (deviceDetails, enable, slotId) => {
    const device = deviceDetails.rawDevice;
    if (!enable) {
      slotId = 0x00;
    }
    const packet = [WRITE, CMD.FLASH_EQ, enable ? 1:0, slotId, END];
    await sendReport(device, REPORT_ID, packet);
  };


// Internal functions
  async function sendReport(device, reportId, packet) {
    if (!device) throw new Error("Device not connected.");
    const data = new Uint8Array(packet);
    console.log(`USB Device PEQ: Walkplay sending report (ID: ${reportId}):`, data);
    await device.sendReport(reportId, data);
  }

// Wait for response
  async function waitForResponse(device, timeout = 2000) {
    return new Promise((resolve, reject) => {
      let response = null;
      const timer = setTimeout(() => {
        console.log(`USB Device PEQ: Walkplay timeout waiting for response after ${timeout}ms`);
        reject("Timeout waiting for HID response");
      }, timeout);

      device.oninputreport = (event) => {
        clearTimeout(timer);
        response = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Walkplay received response:`, response);
        resolve(response);
      };
    });
  }

  // Read global gain from device
  async function readGlobalGain(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([READ, CMD.GLOBAL_GAIN, 0x00]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading global gain");
      }, 100);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Walkplay onInputReport received global gain data:`, data);
        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        if (data[0] !== READ || data[1] !== CMD.GLOBAL_GAIN) return;
        const int8 = new Int8Array([data[4]])[0];
        const globalGain = int8;
        console.log(`USB Device PEQ: Walkplay global gain value: ${globalGain}`);
        resolve(globalGain);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Walkplay sending readGlobalGain command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

// Write global gain to device
  async function writeGlobalGain(device, value) {
    const gainValue = Math.round(value);
    // Match attached KeyX JS format: [WRITE, GLOBAL_GAIN, 0x02, 0x00, gain]
    const request = new Uint8Array([WRITE, CMD.GLOBAL_GAIN, 0x02, 0x00, gainValue]);
    console.log(`USB Device PEQ: Walkplay sending writeGlobalGain command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  return {
    pushToDevice,
    pullFromDevice,
    getCurrentSlot,
    enablePEQ
  };
})();

function delay(ms) {
  return new Promise(resolve => setTimeout(resolve, ms));
}

async function waitForFilters(condition, device, timeout, callback) {
  return new Promise((resolve, reject) => {
    const timer = setTimeout(() => {
      if (!condition()) {
        console.warn("Timeout: Filters not fully received.");
        // Instead of rejecting with the callback result, create a proper result with partial data
        const result = callback(device);
        // Add information about the timeout to help with debugging
        result.complete = false;
        result.receivedCount = result.filters.filter(f => f !== undefined).length;
        result.expectedCount = device.max;
        // Resolve with partial data instead of rejecting
        resolve(result);
      } else {
        const result = callback(device);
        result.complete = true;
        resolve(result);
      }
    }, timeout);

    const interval = setInterval(() => {
      if (condition()) {
        clearTimeout(timer);
        clearInterval(interval);
        const result = callback(device);
        result.complete = true;
        resolve(result);
      }
    }, 100);
  });
}



// Compute IIR filter
function computeIIRFilter(i, freq, gain, q) {
  let bArr = new Array(20).fill(0);
  let sqrt = Math.sqrt(Math.pow(10, gain / 20));
  let d3 = (freq * 6.283185307179586) / 96000;
  let sin = Math.sin(d3) / (2 * q);
  let d4 = sin * sqrt;
  let d5 = sin / sqrt;
  let d6 = d5 + 1;
  let quantizerData = quantizer(
    [1, (Math.cos(d3) * -2) / d6, (1 - d5) / d6],
    [(d4 + 1) / d6, (Math.cos(d3) * -2) / d6, (1 - d4) / d6]
  );

  let index = 0;
  for (let value of quantizerData) {
    bArr[index] = value & 0xFF;
    bArr[index + 1] = (value >> 8) & 0xFF;
    bArr[index + 2] = (value >> 16) & 0xFF;
    bArr[index + 3] = (value >> 24) & 0xFF;
    index += 4;
  }

  return bArr;
}

// Convert values to byte array
function convertToByteArray(value, length) {
  let arr = [];
  for (let i = 0; i < length; i++) {
    arr.push((value >> (8 * i)) & 0xFF);
  }
  return arr;
}

// Quantizer function for IIR filter
function quantizer(dArr, dArr2) {
  let iArr = dArr.map(d => Math.round(d * 1073741824));
  let iArr2 = dArr2.map(d => Math.round(d * 1073741824));
  return [iArr2[0], iArr2[1], iArr2[2], -iArr[1], -iArr[2]];
}
  return walkplayUsbHID;
})();

// ==== moondropUsbHidHandler.js ====
const moondropUsbHidHandler = (() => {
const moondropUsbHidHandler = (function () {
  const FILTER_COUNT = 8;
  const REPORT_ID = 0x4b;
  const COMMAND_WRITE = 1;
  const COMMAND_READ = 128;
  const COMMAND_UPDATE_EQ = 9;
  const COMMAND_UPDATE_EQ_COEFF_TO_REG = 10;
  const COMMAND_SAVE_EQ_TO_FLASH = 1;
  const COMMAND_SET_DAC_OFFSET = 3;
  const COMMAND_CLEAR_FLASH = 0x05;
  const COMMAND_CHANNEL_BALANCE = 0x16;
  const COMMAND_DAC_GAIN = 0x19;
  const COMMAND_DAC_MODE = 0x1D;
  const COMMAND_LED_SWITCH = 0x18;
  const COMMAND_DAC_FILTER = 0x11;
  const COMMAND_VER = 0x0C;
  const COMMAND_RESET_EQ = 0x05;
  const COMMAND_RESET_FLASH = 0x17;
  const COMMAND_UPGRADE = 0xFF;

  function buildReadPacket(filterIndex) {
    return new Uint8Array([COMMAND_READ, COMMAND_UPDATE_EQ, 0x18, 0x00, filterIndex, 0x00]);
  }

  function decodeFilterResponse(data) {
    const e = new Int8Array(data.buffer);

    const rawFreq = (e[27] & 0xff) | ((e[28] & 0xff) << 8);
    const freq = rawFreq;

    const q = (e[30] & 0xff) + (e[29] & 0xff) / 256;
    const rawGain = e[32] + (e[31] & 0xff) / 256;
    const gain = Math.floor(rawGain * 10) / 10;
    const filterType = convertToFilterType(e[33]);
    const valid = freq > 10 && freq < 24000 && !isNaN(gain) && !isNaN(q);

    return {
      type: filterType,
      freq: valid ? freq : 0,
      q: valid ? q : 1.0,
      gain: valid ? gain : 0.0,
      disabled: !valid
    };
  }

  function convertToFilterType(byte) {
    switch (byte) {
      case 1: return "LSQ"; // Low Shelf (if seen in future captures)
      case 2: return "PK"; // Peaking
      case 3: return "HSQ"; // High Shelf (future-proof)
      default: return "PK";
    }
  }

  async function getCurrentSlot(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const request = new Uint8Array([0x80, 0x0F, 0x00]); // READ, SET_ACTIVE_EQ, bLength = 0

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading current slot");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received slot data:`, data);
        if (data[0] !== 0x80 || data[1] !== 0x0F) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        console.log(`USB Device PEQ: Moondrop current slot: ${data[3]}`);
        resolve(data[3]); // slot ID
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending getCurrentSlot command:`, request);
      await device.sendReport(0x4B, request);
    });
  }

  async function readFullFilter(device, filterIndex) {
    const packet = buildReadPacket(filterIndex);

    return new Promise(async (resolve, reject) => {
      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading filter");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received filter ${filterIndex} data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_UPDATE_EQ) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const filter = decodeFilterResponse(data);
        console.log(`USB Device PEQ: Moondrop filter ${filterIndex} decoded:`, filter);
        resolve(filter);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readFilter ${filterIndex} command:`, packet);
      await device.sendReport(REPORT_ID, packet);
    });
  }

  async function readPregain(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_SET_DAC_OFFSET]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading pregain");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received pregain data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_SET_DAC_OFFSET) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const pregain = data[4];
        console.log(`USB Device PEQ: Moondrop pregain value: ${pregain}`);
        resolve(pregain);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readPregain command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writePregain(device, value) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_SET_DAC_OFFSET, 0x02, 0x00, value]);
    console.log(`USB Device PEQ: Moondrop sending writePregain command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function pullFromDevice(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const filters = [];

    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      const filter = await readFullFilter(device, i);
      filters.push(filter);
    }

    const globalGain = await readPregain(device);

    return {
      filters,
      globalGain
    };
  }

  function toLittleEndianBytes(value, scale = 1) {
    const v = Math.round(value * scale);
    return [v & 0xff, (v >> 8) & 0xff];
  }

  function toSignedLittleEndianBytes(value, scale = 1) {
    let v = Math.round(value * scale);
    if (v < 0) v += 0x10000;
    return [v & 0xff, (v >> 8) & 0xff];
  }

  function encodeBiquad(freq, gain, q) {
    const A = Math.pow(10, gain / 40);
    const w0 = (2 * Math.PI * freq) / 96000;
    const alpha = Math.sin(w0) / (2 * q);
    const cosW0 = Math.cos(w0);
    const norm = 1 + alpha / A;

    const b0 = (1 + alpha * A) / norm;
    const b1 = (-2 * cosW0) / norm;
    const b2 = (1 - alpha * A) / norm;
    const a1 = -b1;
    const a2 = (1 - alpha / A) / norm;

    return [b0, b1, b2, a1, -a2].map(c => Math.round(c * 1073741824));
  }

  function encodeToByteArray(coeffs) {
    const arr = new Uint8Array(20);
    for (let i = 0; i < coeffs.length; i++) {
      const val = coeffs[i];
      arr[i * 4] = val & 0xff;
      arr[i * 4 + 1] = (val >> 8) & 0xff;
      arr[i * 4 + 2] = (val >> 16) & 0xff;
      arr[i * 4 + 3] = (val >> 24) & 0xff;
    }
    return arr;
  }

  function buildWritePacket(filterIndex, { freq, gain, q, type }) {
    const packet = new Uint8Array(63);
    packet[0] = COMMAND_WRITE;
    packet[1] = COMMAND_UPDATE_EQ;
    packet[2] = 0x18; // bLength
    packet[3] = 0x00;
    packet[4] = filterIndex;
    packet[5] = 0x00;
    packet[6] = 0x00;

    const coeffs = encodeToByteArray(encodeBiquad(freq, gain, q));
    packet.set(coeffs, 7);

    packet[27] = freq & 0xff;
    packet[28] = (freq >> 8) & 0xff;
    packet[29] = Math.round(q % 1 * 256);
    packet[30] = Math.floor(q);
    packet[31] = Math.round(gain % 1 * 256);
    packet[32] = Math.floor(gain);
    packet[33] = convertFromFilterType(type); // 2 by default
    packet[34] = 0;
    packet[35] = 7; // peqIndex

    return packet;
  }

  function convertFromFilterType(filterType) {
    const mapping = {"PK": 2, "LSQ": 1, "HSQ": 3};
    return mapping[filterType] !== undefined ? mapping[filterType] : 2;
  }

  function buildEnablePacket(filterIndex) {
    const packet = new Uint8Array(63);
    packet[0] = COMMAND_WRITE;
    packet[1] = COMMAND_UPDATE_EQ_COEFF_TO_REG;
    packet[2] = filterIndex;
    packet[3] = 0;
    packet[4] = 255;
    packet[5] = 255;
    packet[6] = 255;
    return packet;
  }

  function buildSavePacket() {
    return new Uint8Array([COMMAND_WRITE, COMMAND_SAVE_EQ_TO_FLASH]);
  }

  async function pushToDevice(deviceDetails, slot, globalGain, filters) {
    const device = deviceDetails.rawDevice;

    for (let i = 0; i < filters.length && i < deviceDetails.modelConfig.maxFilters; i++) {
      const writeFilter = buildWritePacket(i, filters[i]);
      console.log(`USB Device PEQ: Moondrop sending filter ${i} data:`, filters[i], writeFilter);
      await device.sendReport(REPORT_ID, writeFilter);

      const enable = buildEnablePacket(i);
      console.log(`USB Device PEQ: Moondrop sending enable command for filter ${i}:`, enable);
      await device.sendReport(REPORT_ID, enable);
    }

    // Write the global gain (pregain)
    await writePregain(device, globalGain);
    console.log(`USB Device PEQ: Moondrop set pregain to ${globalGain}`);

    const save = buildSavePacket();
    console.log(`USB Device PEQ: Moondrop sending save command:`, save);
    await device.sendReport(REPORT_ID, save);

    console.log(`USB Device PEQ: Moondrop successfully pushed ${filters.length} filters to device`);
    return false;
  }

  async function readVer(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_VER]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading version");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received version data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_VER) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const version = `${data[3]}.${data[4]}.${data[5]}`;
        console.log(`USB Device PEQ: Moondrop version: ${version}`);
        resolve(version);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readVer command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function readChannelBalance(device, lr) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_CHANNEL_BALANCE, 0, lr]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading channel balance");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received channel balance data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_CHANNEL_BALANCE) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const balance = data[5];
        console.log(`USB Device PEQ: Moondrop channel balance value: ${balance}`);
        resolve(balance);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readChannelBalance command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeChannelBalance(device, lr, db) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_CHANNEL_BALANCE, 0, lr, 0, db, 0]);
    console.log(`USB Device PEQ: Moondrop sending writeChannelBalance command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACGain(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_GAIN, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC gain");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC gain data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_GAIN) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const gain = data[3];
        console.log(`USB Device PEQ: Moondrop DAC gain value: ${gain}`);
        resolve(gain);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACGain command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACGain(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_GAIN, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACGain command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACMode(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_MODE, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC mode");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC mode data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_MODE) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const mode = data[3];
        console.log(`USB Device PEQ: Moondrop DAC mode value: ${mode}`);
        resolve(mode);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACMode command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACMode(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_MODE, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACMode command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readLEDSwitch(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_LED_SWITCH, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading LED switch");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received LED switch data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_LED_SWITCH) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const ledSwitch = data[3];
        console.log(`USB Device PEQ: Moondrop LED switch value: ${ledSwitch}`);
        resolve(ledSwitch);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readLEDSwitch command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeLEDSwitch(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_LED_SWITCH, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeLEDSwitch command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function readDACFilter(device) {
    return new Promise(async (resolve, reject) => {
      const request = new Uint8Array([COMMAND_READ, COMMAND_DAC_FILTER, 0]);

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading DAC filter");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: Moondrop onInputReport received DAC filter data:`, data);
        if (data[0] !== COMMAND_READ || data[1] !== COMMAND_DAC_FILTER) return;

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);
        const filter = data[3];
        console.log(`USB Device PEQ: Moondrop DAC filter value: ${filter}`);
        resolve(filter);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readDACFilter command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writeDACFilter(device, vl) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_DAC_FILTER, 1, vl]);
    console.log(`USB Device PEQ: Moondrop sending writeDACFilter command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function resetEQ(device) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_RESET_EQ, 1, 4, 0]);
    console.log(`USB Device PEQ: Moondrop sending resetEQ command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function resetFlash(device) {
    const request = new Uint8Array([COMMAND_WRITE, COMMAND_RESET_FLASH, 0]);
    console.log(`USB Device PEQ: Moondrop sending resetFlash command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice,
    enablePEQ: async () => {}, // not required for Moondrop
    readVer,
    readChannelBalance,
    writeChannelBalance,
    readDACGain,
    writeDACGain,
    readDACMode,
    writeDACMode,
    readLEDSwitch,
    writeLEDSwitch,
    readDACFilter,
    writeDACFilter,
    resetEQ,
    resetFlash
  };
})();
  return moondropUsbHidHandler;
})();

// ==== ktmicroUsbHidHandler.js ====
const ktmicroUsbHidHandler = (() => {
const ktmicroUsbHidHandler = (function () {
  const FILTER_COUNT = 10;
  const REPORT_ID = 0x4b;
  const COMMAND_READ = 0x52;
  const COMMAND_WRITE = 0x57;
  const COMMAND_COMMIT = 0x53;
  const COMMAND_CLEAR = 0x43;

  function buildReadPacket(filterFieldToRequest) {
    return new Uint8Array([filterFieldToRequest, 0x00, 0x00, 0x00, COMMAND_READ, 0x00, 0x00, 0x00, 0x00]);
  }

  function buildReadGlobalPacket() {
    return new Uint8Array([0x66, 0x00, 0x00, 0x00, COMMAND_READ, 0x00, 0x00, 0x00, 0x00]);
  }

  function buildWriteGlobalPacket() {
    return new Uint8Array([0x66, 0x00, 0x00, 0x00, COMMAND_WRITE, 0x00, 0x00, 0x00, 0x00]);
  }

  function buildEnableEQPacket(slotId) {
    return new Uint8Array([0x24, 0x00, 0x00, 0x00, COMMAND_WRITE, 0x00, slotId, 0x00, 0x00, 0x00]);
  }
  function buildReadEQPacket(enable) {
    return new Uint8Array([0x24, 0x00, 0x00, 0x00, COMMAND_READ, 0x00, 0x03, 0x00, 0x00, 0x00]);
  }

  function decodeGainFreqResponse(data,compensate2X) {
    const gainRaw = data[6] | (data[7] << 8);
    const gain = gainRaw > 0x7FFF ? gainRaw - 0x10000 : gainRaw; // signed 16-bit
    var freq = data[8] + (data[9] << 8);
    if (compensate2X) {
      freq = freq * 2;
    }

    return { gain: gain / 10.0, freq };
  }

  function decodeQResponse(data) {
    const q = (data[6] + (data[7] << 8)) / 1000.0;
    let type = "PK"; // Default to Peak filter

    // Read filter type from byte 8
    const filterTypeValue = data[8];
    if (filterTypeValue === 3) {
      type = "LSQ"; // Low Shelf
    } else if (filterTypeValue === 0) {
      type = "PK"; // Peak
    } else if (filterTypeValue === 4) {
      type = "HSQ"; // High Shelf
    }

    return { q, type };
  }

  async function getCurrentSlot (deviceDetails){
    var device = deviceDetails.rawDevice;
    return new Promise(async (resolve, reject) => {
      const request = buildReadEQPacket();

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading slot");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: KTMicro onInputReport received slot data:`, data);

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);

        const slotId = data[6];  //

        console.log(`USB Device PEQ: KTMicro read slot value: ${slotId}`);
        resolve(slotId);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readPregain command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function readFullFilter(device, filterIndex, compensate2X) {
    const gainFreqId = 0x26 + filterIndex * 2;
    const qId = gainFreqId + 1;

    const requestGainFreq = buildReadPacket(gainFreqId);
    const requestQ = buildReadPacket(qId);

    return new Promise(async (resolve, reject) => {
      const result = {};
      const timeout = setTimeout(() => {
        device.removeEventListener('inputreport', onReport);
        reject("Timeout reading filter");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: KTMicro onInputReport received data:`, data);
        if (data[4] !== COMMAND_READ) return;

        if (data[0] === gainFreqId) {
          const gainFreqData = decodeGainFreqResponse(data, compensate2X);
          console.log(`USB Device PEQ: KTMicro filter ${filterIndex} gain/freq decoded:`, gainFreqData);
          Object.assign(result, gainFreqData);
        } else if (data[0] === qId) {
          const qData = decodeQResponse(data);
          console.log(`USB Device PEQ: KTMicro filter ${filterIndex} Q decoded:`, qData);
          Object.assign(result, qData);
        }

        if ('gain' in result && 'freq' in result && 'q' in result && 'type' in result) {
          clearTimeout(timeout);
          device.removeEventListener('inputreport', onReport);
          console.log(`USB Device PEQ: KTMicro filter ${filterIndex} complete:`, result);
          resolve(result);
        }
      };

      device.addEventListener('inputreport', onReport);
      console.log(`USB Device PEQ: KTMicro sending gain/freq request for filter ${filterIndex}:`, requestGainFreq);
      await device.sendReport(REPORT_ID, requestGainFreq);
      console.log(`USB Device PEQ: KTMicro sendReport gain/freq for filter ${filterIndex} sent`);

      console.log(`USB Device PEQ: KTMicro sending Q request for filter ${filterIndex}:`, requestQ);
      await device.sendReport(REPORT_ID, requestQ);

      console.log(`USB Device PEQ: KTMicro sendReport Q for filter ${filterIndex} sent`);
    });
  }

  async function readPregain(device) {
    return new Promise(async (resolve, reject) => {
      const request = buildReadGlobalPacket();

      const timeout = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        reject("Timeout reading pregain");
      }, 1000);

      const onReport = (event) => {
        const data = new Uint8Array(event.data.buffer);
        console.log(`USB Device PEQ: KTMicro onInputReport received pregain data:`, data);

        clearTimeout(timeout);
        device.removeEventListener("inputreport", onReport);

        const rawPregain = data[6];  //
        var pregain = 0;
        if (rawPregain > 127) {
          pregain = rawPregain - 256;
        } else {
          pregain = rawPregain;
        }

        console.log(`USB Device PEQ: KTMicro pregain value: ${pregain}`);
        resolve(pregain);
      };

      device.addEventListener("inputreport", onReport);
      console.log(`USB Device PEQ: Moondrop sending readPregain command:`, request);
      await device.sendReport(REPORT_ID, request);
    });
  }

  async function writePregain(device, value) {
    const request = buildWriteGlobalPacket();

    let processedGlobalGain = Math.round(value); // Ensure it's a whole number
    if (processedGlobalGain < 0) {
      processedGlobalGain = processedGlobalGain & 0xFF;
    }

    request[6] = processedGlobalGain;

    console.log(`USB Device PEQ: Moondrop sending writePregain command:`, request);
    await device.sendReport(REPORT_ID, request);
  }

  async function pullFromDevice(deviceDetails) {
    const device = deviceDetails.rawDevice;
    const compensate2X = deviceDetails.modelConfig.compensate2X;
    const filters = [];
    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      const filter = await readFullFilter(device, i, compensate2X);
      filters.push(filter);
    }

    const pregain = readPregain(device);

    return { filters, globalGain: pregain };
  }

  function toLittleEndianBytes(value, scale = 1) {
    const v = Math.round(value * scale);
    return [v & 0xff, (v >> 8) & 0xff];
  }

  function toSignedLittleEndianBytes(value, scale = 1) {
    let v = Math.round(value * scale);
    if (v < 0) v += 0x10000; // Convert to unsigned 16-bit
    return [v & 0xFF, (v >> 8) & 0xFF];
  }

  function buildWritePacket(filterId, freq, gain) {
    const freqBytes = toLittleEndianBytes(freq);
    const gainBytes = toSignedLittleEndianBytes(gain, 10);
    return new Uint8Array([
      filterId, 0x00, 0x00, 0x00, COMMAND_WRITE, 0x00, gainBytes[0], gainBytes[1], freqBytes[0], freqBytes[1]
    ]);
  }

  function buildQPacket(filterId, q, type) {
    const qBytes = toLittleEndianBytes(q, 1000);
    var filterTypeValue = 0;
    if (type === "LSQ") {
      filterTypeValue = 3; // Low Shelf
    } else if (type === "HSQ") {
      filterTypeValue = 4; // High Shelf
    }

    return new Uint8Array([
      filterId, 0x00, 0x00, 0x00, COMMAND_WRITE, 0x00, qBytes[0], qBytes[1], filterTypeValue, 0x00
    ]);
  }

  function buildCommand(commandCode) {
    return new Uint8Array([
      0x00, 0x00, 0x00, 0x00, commandCode, 0x00, 0x00, 0x00, 0x00, 0x00
    ]);
  }

  async function pushClearToDevice(device) {
    // Send a clear first ( sort of like a reset )
    const clear = buildCommand(COMMAND_CLEAR);
    console.log(`USB Device PEQ: KTMicro sending clear command:`, clear);
    await device.sendReport(REPORT_ID, clear);
    console.log(`USB Devic  e PEQ: KTMicro sendReport clear sent`);

    await new Promise(resolve => setTimeout(resolve, 200)); // Added 100ms delay
  }

  async function pushToDevice(deviceDetails, slot, globalGain, filters) {
    const device = deviceDetails.rawDevice;

    // First check if we need to enable PEQ
    const currentSlot = await getCurrentSlot(deviceDetails);
    if (currentSlot === deviceDetails.modelConfig.disabledPresetId) {
      // Use the first of the availableSlots to 'enable' that slot
      slot = deviceDetails.modelConfig.availableSlots[0].id;
      console.log(`USB Device PEQ: KTMicro device is disabled, enabling it first with slot ${slot}`);
      await enablePEQ(deviceDetails, true, slot);
    }

    try {

      // Now write the filters
      for (let i = 0; i < filters.length; i++) {
        if (i >= deviceDetails.modelConfig.maxFilters) break;

        const filterId = 0x26 + i * 2;
        var freqToWrite = filters[i].freq;
        if (deviceDetails.modelConfig.compensate2X) { // Most older KTMicro devices set the wrong frequency
          freqToWrite = filters[i].freq / 2;  // 100Hz seems to end up as 200Hz
        }
        var gain = filters[i].gain;
        if (filters[i].disabled) {
          gain = 0;
        }
        const writeGainFreq = buildWritePacket(filterId, freqToWrite, gain);
        const writeQ = buildQPacket(filterId + 1, filters[i].q, filters[i].type);

        // We should verify it is saved correctly but for now lets assume once command is accepted it has worked
        console.log(`USB Device PEQ: KTMicro sending gain/freq for filter ${i}:`, filters[i], writeGainFreq);
        await device.sendReport(REPORT_ID, writeGainFreq);
        console.log(`USB Device PEQ: KTMicro sendReport gain/freq for filter ${i} sent`);

        console.log(`USB Device PEQ: KTMicro sending Q for filter ${i}:`, filters[i].q, writeQ);
        await device.sendReport(REPORT_ID, writeQ);
        console.log(`USB Device PEQ: KTMicro sendReport Q for filter ${i} sent`);
      }
    } catch (e) {
      console.log(`USB Device PEQ: KTMicro Error`, e);
      throw e;
    }

    if (deviceDetails.modelConfig.supportsPregain) {
      writePregain(device, globalGain);
    }

    const commit = buildCommand (COMMAND_COMMIT);
    console.log(`USB Device PEQ: KTMicro sending commit command:`, commit);
    await device.sendReport(REPORT_ID, commit);
    console.log(`USB Device PEQ: KTMicro sendReport commit sent`);

    await new Promise(resolve => setTimeout(resolve, 1000)); // Added 100ms delay

    console.log(`USB Device PEQ: KTMicro successfully pushed ${filters.length} filters to device`);
    if (deviceDetails.modelConfig.disconnectOnSave) {
      return true;    // Disconnect
    }
    return false;
  }

  const enablePEQ = async (deviceDetails, enable, slotId) => {

    // KT micro - has issue if device is PEQ was disabled we try to enable it
    var device = deviceDetails.rawDevice

    if (slotId === deviceDetails.modelConfig.disabledPresetId || enable === false) {
      slotId = deviceDetails.modelConfig.disabledPresetId; // Disable
      //await pushClearToDevice(device);
    }

    const enableEQPacket = buildEnableEQPacket(slotId);

    console.log(`USB Device PEQ: KTMicro enable PEQ request`, enableEQPacket);
    await device.sendReport(REPORT_ID, enableEQPacket);

  }

  return {
    getCurrentSlot,
    pushToDevice,
    pullFromDevice,
    enablePEQ,
  };
})();
  return ktmicroUsbHidHandler;
})();

// ==== qudelixUsbHidHandler.js ====
const qudelixUsbHidHandler = (() => {
// qudelixUsbHidHandler.js
// Pragmatic Audio - Handler for Qudelix 5K USB HID EQ Control

const qudelixUsbHidHandler = (function () {
  // HID Report IDs from Qudelix protocol
  const HID_REPORT_ID = {
    DATA_TRANSFER: 1,
    RESPONSE: 2,
    COMMAND: 3,
    CONTROL: 4,
    UPGRADE_DATA_TRANSFER: 5,
    UPGRADE_RESPONSE: 6,
    QX_OUT: 7,
    QX_HOST_TO_DEVICE: 8,
    QX_DEVICE_TO_HOST: 9
  };

  // Qudelix EQ filter types
  const FILTER_TYPES = {
    BYPASS: 0,
    LPF: 7,     // 2nd order LPF
    HPF: 8,     // 2nd order HPF
    PEQ: 13,    // Parametric EQ
    LS: 10,     // 2nd order Low Shelf
    HS: 11      // 2nd order High Shelf
  };

  // HID communication state
  let hidReportInfo = [];
  let sendReportId = 0;
  let sendReportSize = 0;

  // App command definitions from qxApp_proto.ts
  const APP_CMD = {
    // Basic commands
    ReqInitData: 0x0001,
    
    // Request commands
    ReqDevConfig: 0x0003,
    ReqEqPreset: 0x0004,
    ReqEqPresetName: 0x0005,

    // Set commands
    SetEqEnable: 0x0102,
    SetEqType: 0x0103,
    SetEqHeadroom: 0x0104,
    SetEqPreGain: 0x0105,
    SetEqGain: 0x0106,
    SetEqFilter: 0x0107,
    SetEqFreq: 0x0108,
    SetEqQ: 0x0109,
    SetEqBandParam: 0x010A,
    SetEqPreset: 0x010B,
    SetEqPresetName: 0x010E,

    // Additional commands
    SaveEqPreset: 0x0202
  };

  // Notification types from Qudelix app
  const NOTIFY_EQ = {
    Enable: 0x01,
    Type: 0x02,
    Headroom: 0x03,
    PreGain: 0x04,
    Gain: 0x05,
    Q: 0x06,
    Filter: 0x07,
    Freq: 0x08,
    Preset: 0x09,
    PresetName: 0x0A,
    Mode: 0x0B,
    ReceiverInfo: 0x0C,
    Band: 0x0D
  };

  // Utility functions
  const utils = {
    // Convert to signed 16-bit integer
    toInt16: function(value) {
      return (value << 16) >> 16;
    },

    // Extract 16-bit value from array at offset
    d16: function(array, offset) {
      return (array[offset] << 8) | array[offset + 1];
    },

    // Get MSB of value
    msb8: function(value) {
      return (value >> 8) & 0xFF;
    },

    // Get LSB of value
    lsb8: function(value) {
      return value & 0xFF;
    },

    // Convert value to little-endian bytes
    toLittleEndianBytes: function(value) {
      return [this.msb8(value), this.lsb8(value)];
    },

    // Convert to signed little-endian bytes with scaling
    toSignedLittleEndianBytes: function(value, scale = 1) {
      let v = Math.round(value * scale);
      if (v < 0) v += 0x10000; // Convert to unsigned 16-bit
      return [this.msb8(v), this.lsb8(v)];
    }
  };

  // Initialize HID report information (similar to AppUsbHid.init_reportInfo)
  function initHidReports(device) {
    hidReportInfo = [];
    const collections = device.collections;
    
    console.log('Qudelix HID: Initializing reports from collections:', collections);
    console.log('Qudelix HID: Total collections found:', collections?.length);
    
    // Debug all collections first
    if (collections?.length) {
      collections.forEach((info, collectionIndex) => {
        console.log(`Collection ${collectionIndex}:`);
        console.log(`  usagePage: 0x${info.usagePage?.toString(16)}`);
        console.log(`  usage: 0x${info.usage?.toString(16)}`);
        console.log(`  featureReports: ${info.featureReports?.length || 0}`);
        console.log(`  inputReports: ${info.inputReports?.length || 0}`);
        console.log(`  outputReports: ${info.outputReports?.length || 0}`);
      });
    }
    
    if (collections?.length) {
      collections.forEach((info, collectionIndex) => {
        console.log(`Processing collection ${collectionIndex}: usagePage=0x${info.usagePage?.toString(16)}`);
        
        // Only process vendor-defined collections (0xFF00)
        if (info.usagePage !== 0xFF00) {
          console.log(`Skipping collection ${collectionIndex} - not vendor-defined (0xFF00)`);
          return;
        }
        // Process feature reports
        info.featureReports?.forEach((report) => {
          const reportId = report.reportId;
          const reportSize = report.items?.[0]?.reportCount || 64; // Default to 64 if not specified
          hidReportInfo.push({ type: 'feature', id: reportId, size: reportSize });
          console.log(`Found feature report: ID=${reportId}, size=${reportSize}`);
        });
        
        // Process input reports
        info.inputReports?.forEach((report) => {
          const reportId = report.reportId;
          const reportSize = report.items?.[0]?.reportCount || 64;
          hidReportInfo.push({ type: 'in', id: reportId, size: reportSize });
          console.log(`Found input report: ID=${reportId}, size=${reportSize}`);
        });
        
        // Process output reports
        info.outputReports?.forEach((report) => {
          const reportId = report.reportId;
          const reportSize = report.items?.[0]?.reportCount || 64;
          hidReportInfo.push({ type: 'out', id: reportId, size: reportSize });
          console.log(`Found output report: ID=${reportId}, size=${reportSize}`);
        });
      });
    }
    
    console.log('Qudelix HID: All found reports:', hidReportInfo);
    
    // Find the best report ID for sending (try qx_hostToDevice first, fallback to qx_out)
    sendReportId = HID_REPORT_ID.QX_HOST_TO_DEVICE;
    sendReportSize = getReportSize(sendReportId);
    
    if (sendReportSize === 0) {
      sendReportId = HID_REPORT_ID.QX_OUT;
      sendReportSize = getReportSize(sendReportId);
    }
    
    // If still no size found, use the first available output report
    if (sendReportSize === 0) {
      const firstOutputReport = hidReportInfo.find(r => r.type === 'out');
      if (firstOutputReport) {
        sendReportId = firstOutputReport.id;
        sendReportSize = firstOutputReport.size;
        console.log(`Qudelix HID: Using first available output report: ID=${sendReportId}, size=${sendReportSize}`);
      } else {
        // Last resort: use a reasonable default
        sendReportId = 7;
        sendReportSize = 64;
        console.log(`Qudelix HID: No reports found, using defaults: ID=${sendReportId}, size=${sendReportSize}`);
      }
    }
    
    console.log(`Qudelix HID: Using report ID ${sendReportId}, size ${sendReportSize}`);
  }
  
  // Get report size for a given ID
  function getReportSize(reportId) {
    const report = hidReportInfo.find(r => r.id === reportId);
    return report?.size || 0;
  }

  // Map filter type from our PEQ format to Qudelix format
  function mapFilterTypeToQudelix(filterType) {
    switch (filterType) {
      case "PK": return FILTER_TYPES.PEQ;
      case "LSQ": return FILTER_TYPES.LS;
      case "HSQ": return FILTER_TYPES.HS;
      case "LPF": return FILTER_TYPES.LPF;
      case "HPF": return FILTER_TYPES.HPF;
      default: return FILTER_TYPES.PEQ;
    }
  }

  // Map Qudelix filter type to our PEQ format
  function mapQudelixToFilterType(filterValue) {
    switch (filterValue) {
      case FILTER_TYPES.PEQ: return "PK";
      case FILTER_TYPES.LS: return "LSQ";
      case FILTER_TYPES.HS: return "HSQ";
      case FILTER_TYPES.LPF: return "LPF";
      case FILTER_TYPES.HPF: return "HPF";
      default: return "PK";
    }
  }

  // Get current EQ slot
  async function getCurrentSlot(deviceDetails) {
    try {
      // For Qudelix 5K, usually slot 101 is the main custom slot
      return 101;
    } catch (error) {
      console.error("Error getting current Qudelix EQ slot:", error);
      return 101; // Return default slot on error
    }
  }

  // Send command using Qudelix protocol (matches Qudelix.command.send)
  async function sendCommand(device, cmdType, payload = []) {
    // Create command packet: [cmdMSB, cmdLSB, ...payload]
    const cmdPayload = new Uint8Array(2 + payload.length);
    cmdPayload[0] = utils.msb8(cmdType);
    cmdPayload[1] = utils.lsb8(cmdType);
    
    for (let i = 0; i < payload.length; i++) {
      cmdPayload[i + 2] = payload[i];
    }
    
    console.log(`Qudelix USB: Sending command 0x${cmdType.toString(16).padStart(4, '0')}:`, [...cmdPayload].map(b => b.toString(16).padStart(2, '0')).join(' '));
    
    // Send via the HID send_cmd method (this will add the HID packet wrapper)
    await sendHidCommand(device, cmdPayload);
    
    // Add a small delay to avoid overwhelming the device
    await new Promise(resolve => setTimeout(resolve, 20));
  }

  // Send HID command with proper packet wrapping (matches AppUsbHid.send_cmd)
  async function sendHidCommand(device, payload) {
    // Create HID packet: length + 0x80 + payload
    const packet = new Uint8Array(sendReportSize);
    packet.fill(0);
    
    // The length field should be: command (1 byte) + payload length
    packet[0] = payload.length + 1; // 0x80 command + payload
    packet[1] = 0x80; // HID command identifier
    packet.set(payload, 2); // Copy payload starting at index 2
    
    console.log(`Qudelix HID: Sending packet (len=${packet[0]}, cmd=0x${packet[1].toString(16)}):`, [...packet.slice(0, packet[0] + 1)].map(b => b.toString(16).padStart(2, '0')).join(' '));
    
    await device.sendReport(sendReportId, packet);
  }

  // Pull EQ settings from the device
  async function pullFromDevice(deviceDetails, slot) {
    const device = deviceDetails.rawDevice;
    const maxBands = deviceDetails.modelConfig.maxFilters || 10;
    const filters = [];

    try {
      // Debug: Show device info
      console.log('Qudelix USB: Device info:', {
        productName: device.productName,
        vendorId: '0x' + device.vendorId.toString(16),
        productId: '0x' + device.productId.toString(16),
        collectionsCount: device.collections?.length
      });

      // Initialize HID reports if not done already
      if (hidReportInfo.length === 0) {
        initHidReports(device);
      }

      // If we don't have the vendor-defined interface, this is the wrong device interface
      if (hidReportInfo.length === 0) {
        console.error('Qudelix USB: WRONG INTERFACE! This appears to be the consumer control interface.');
        console.error('Qudelix USB: You need to select the vendor-defined HID interface when connecting.');
        console.error('Qudelix USB: Look for the interface with usagePage=0xFF00 in the browser device picker.');
        
        return { 
          filters: [], 
          globalGain: 0, 
          error: 'Wrong HID interface selected. Please reconnect and choose the vendor-defined interface.' 
        };
      }

      // First, let's just listen for any data the device might be sending
      console.log('Qudelix USB: Setting up listeners to detect any device activity...');
      
      // Try a very simple approach - just listen for any input reports for 2 seconds
      return new Promise((resolve, reject) => {
        let timeout = null;
        let anyDataReceived = false;
        
        const universalHandler = function(event) {
          anyDataReceived = true;
          const reportId = event.reportId;
          const data = new Uint8Array(event.data.buffer);
          
          console.log(`Qudelix USB: DETECTED DATA! Report ID ${reportId}, length ${data.length}, data:`, [...data].map(b => b.toString(16).padStart(2, '0')).join(' '));
          
          // Try to parse any data we receive
          if (data.length > 2) {
            const cmd = (data[0] << 8) | data[1];
            console.log(`Qudelix USB: Possible command response: 0x${cmd.toString(16).padStart(4, '0')}`);
          }
        };
        
        device.addEventListener('inputreport', universalHandler);
        
        // Set a shorter timeout to see if device sends anything spontaneously
        timeout = setTimeout(() => {
          device.removeEventListener('inputreport', universalHandler);
          
          if (anyDataReceived) {
            console.log('Qudelix USB: Device is sending data! Check logs above.');
            resolve({ filters: [], globalGain: 0, message: 'Device communicating but need to decode protocol' });
          } else {
            console.log('Qudelix USB: No data received. Trying to send initialization commands...');
            // If no spontaneous data, try sending commands
            tryInitialization(device, resolve, reject);
          }
        }, 2000); // Wait 2 seconds for any spontaneous data
      });

    } catch (error) {
      console.error("Error pulling EQ from Qudelix:", error);
      return { filters: [], globalGain: 0 };
    }
  }

  // Try initialization commands if no spontaneous data
  async function tryInitialization(device, resolve, reject) {
    console.log('Qudelix USB: Trying initialization sequence...');
    
    try {
      let timeout = null;
      let receivedData = false;
      const filters = [];
      let preGain = 0;

      const responseHandler = function(event) {
        receivedData = true;
        const reportId = event.reportId;
        const data = new Uint8Array(event.data.buffer);

        console.log(`Qudelix USB: Response received! Report ID ${reportId}, length ${data.length}, data:`, [...data].map(b => b.toString(16).padStart(2, '0')).join(' '));

        // Try to parse as HID packet format
        if (data.length >= 3) {
          const len = data[0];
          const cmd = (data[1] << 8) | data[2];
          console.log(`Qudelix USB: HID packet - len=${len}, cmd=0x${cmd.toString(16).padStart(4, '0')}`);
        }

        // For now, just return success if we get any response
        if (timeout) clearTimeout(timeout);
        device.removeEventListener('inputreport', responseHandler);
        resolve({ 
          filters, 
          globalGain: preGain, 
          message: `Got response on report ID ${reportId}` 
        });
      };

      device.addEventListener('inputreport', responseHandler);

      // Try different communication methods
      await testCommunication(device);

      // Set timeout
      timeout = setTimeout(() => {
        device.removeEventListener('inputreport', responseHandler);
        if (receivedData) {
          resolve({ filters, globalGain: preGain });
        } else {
          reject(new Error("No response from device after initialization"));
        }
      }, 3000);

    } catch (error) {
      reject(error);
    }
  }

  // Test different communication approaches
  async function testCommunication(device) {
    console.log('Qudelix USB: Testing different packet formats...');
    
    // Test 1: Try direct ReqDevConfig with HID wrapper
    console.log('Qudelix USB: Test 1 - ReqDevConfig with HID wrapper');
    await sendCommand(device, APP_CMD.ReqDevConfig, []);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Test 2: Try raw packet without 0x80 wrapper
    console.log('Qudelix USB: Test 2 - Raw ReqDevConfig packet');
    const rawPacket = new Uint8Array(sendReportSize);
    rawPacket.fill(0);
    rawPacket[0] = 0x00; // MSB of ReqDevConfig (0x0003)
    rawPacket[1] = 0x03; // LSB of ReqDevConfig
    console.log(`Qudelix USB: Sending raw packet:`, [...rawPacket.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' '));
    await device.sendReport(sendReportId, rawPacket);
    await new Promise(resolve => setTimeout(resolve, 100));
    
    // Test 3: Try different report ID (7)
    if (sendReportId !== 7) {
      console.log('Qudelix USB: Test 3 - Trying report ID 7');
      const packet7 = new Uint8Array(64); // Assume size 64 for report 7
      packet7.fill(0);
      packet7[0] = 0x00;
      packet7[1] = 0x03;
      console.log(`Qudelix USB: Sending on report ID 7:`, [...packet7.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' '));
      await device.sendReport(7, packet7);
      await new Promise(resolve => setTimeout(resolve, 100));
    }
    
    // Test 4: Try feature reports (might be needed for initialization)
    console.log('Qudelix USB: Test 4 - Trying feature report ID 4');
    try {
      const featurePacket = new Uint8Array(3); // Feature report ID 4, size 3
      featurePacket[0] = 0x00;
      featurePacket[1] = 0x03;
      featurePacket[2] = 0x00;
      console.log(`Qudelix USB: Sending feature report:`, [...featurePacket].map(b => b.toString(16).padStart(2, '0')).join(' '));
      await device.sendFeatureReport(4, featurePacket);
      await new Promise(resolve => setTimeout(resolve, 100));
    } catch (error) {
      console.log('Qudelix USB: Feature report failed:', error.message);
    }
    
    // Test 5: Try a simple "ping" or status request
    console.log('Qudelix USB: Test 5 - Simple status request on report ID 1');
    const statusPacket = new Uint8Array(65); // Report ID 1, size 65
    statusPacket.fill(0);
    statusPacket[0] = 0x00; // Simple status request
    statusPacket[1] = 0x01;
    console.log(`Qudelix USB: Sending status request:`, [...statusPacket.slice(0, 8)].map(b => b.toString(16).padStart(2, '0')).join(' '));
    await device.sendReport(1, statusPacket);
  }

  // Push EQ settings to the device
  async function pushToDevice(deviceDetails, slot, preamp, filters) {
    const device = deviceDetails.rawDevice;

    try {
      // Initialize HID reports if not done already
      if (hidReportInfo.length === 0) {
        initHidReports(device);
      }

      // Step 1: Enable EQ
      await sendCommand(device, APP_CMD.SetEqEnable, [1]);

      // Step 2: Set PreGain (global gain)
      const preGainScaled = Math.round(preamp * 10); // Scale by 10
      const preGainBytes = utils.toSignedLittleEndianBytes(preGainScaled);

      // Set the same value for both channels
      await sendCommand(device, APP_CMD.SetEqPreGain, [
        preGainBytes[0], preGainBytes[1], // Left channel
        preGainBytes[0], preGainBytes[1]  // Right channel (same value)
      ]);

      // Step 3: Set each filter band
      for (let i = 0; i < filters.length; i++) {
        const filter = filters[i];
        if (i >= deviceDetails.modelConfig.maxFilters) break;

        if (filter.disabled) continue;

        const filterType = mapFilterTypeToQudelix(filter.type);
        const freqScaled = Math.round(filter.freq);
        const gainScaled = Math.round(filter.gain * 10);
        const qScaled = Math.round(filter.q * 100);

        const freqBytes = utils.toLittleEndianBytes(freqScaled);
        const gainBytes = utils.toSignedLittleEndianBytes(gainScaled);
        const qBytes = utils.toLittleEndianBytes(qScaled);

        // Set filter parameters one by one
        await sendCommand(device, APP_CMD.SetEqFilter, [i, filterType]);
        await sendCommand(device, APP_CMD.SetEqFreq, [i, freqBytes[0], freqBytes[1]]);
        await sendCommand(device, APP_CMD.SetEqGain, [i, gainBytes[0], gainBytes[1]]);
        await sendCommand(device, APP_CMD.SetEqQ, [i, qBytes[0], qBytes[1]]);
      }

      // Step 4: Save to preset
      if (slot > 0) {
        await sendCommand(device, APP_CMD.SaveEqPreset, [slot]);
      }

      return false; // Generally no need to disconnect for Qudelix
    } catch (error) {
      console.error("Error pushing EQ to Qudelix:", error);
      throw error;
    }
  }

  // Enable/disable EQ
  async function enablePEQ(deviceDetails, enabled, slotId) {
    try {
      const device = deviceDetails.rawDevice;
      
      // Initialize HID reports if not done already
      if (hidReportInfo.length === 0) {
        initHidReports(device);
      }

      // Enable/disable EQ
      await sendCommand(device, APP_CMD.SetEqEnable, [enabled ? 1 : 0]);

      // If enabled and a valid slot ID is provided, switch to that preset
      if (enabled && slotId > 0) {
        await sendCommand(device, APP_CMD.SetEqPreset, [slotId]);
      }
    } catch (error) {
      console.error("Error setting Qudelix EQ state:", error);
    }
  }

  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice,
    enablePEQ
  };
})();
  return qudelixUsbHidHandler;
})();

// ==== toppingUsbHidHandler.js ====
const toppingUsbHidHandler = (() => {
const toppingUsbHidHandler = (function () {
  // ===== Known scheme from logs =====
  // Band page: base = 0x90 + bandIndex (0-based; band 0 => 0x90, band 1 => 0x91, band 2 => 0x92, ...)
  // Write ops (per band):
  //   enable: base+0x06  (data: 0/1)
  //   freq:   base+0x07  (data: Hz, integer)
  //   gain:   base+0x08  (data: dB*2, half-dB steps, signed)
  //   q:      base+0x09  (data: Q*10000, integer)
  //   apply:  base+0x0A  (data: 1)
  //
  // NOTE: Report format on your device appears to be [cmd, data] in the HID payload; we keep REPORT_ID=1.

  const REPORT_ID = 0x01;

  // Helpers -------------------------------------------------------
  const bandBase = (filterIndex) => (0x90 + filterIndex) & 0xFF;

  // Clamp & encoders (defensive)
  const encFreq = (hz) => Math.max(1, Math.round(hz));
  const encGainSteps = (db) => {
    // half-dB steps, signed 16-bit safe
    const v = Math.round(db * 2);
    // device accepted small positives; keep as 16-bit signed range
    return ((v << 16) >> 16); // ensure JS -> signed 16
  };
  const encQ = (q) => Math.max(1, Math.round(q * 10000));

  // Send a single 2-byte command (cmd + data as 16/32?). Your logs show small integers.
  // WebHID sendReport takes (reportId, data: BufferSource)
  // We'll serialize as little-endian Uint32 for data to be safe; adjust if your device expects 16-bit.
  function makePacket(cmd, data) {
    // [cmd (1B), data (4B LE)]
    const buf = new ArrayBuffer(5);
    const view = new DataView(buf);
    view.setUint8(0, cmd & 0xFF);
    view.setUint32(1, data >>> 0, true);
    return new Uint8Array(buf);
  }

  async function sendCmd(device, cmd, data) {
    const pkt = makePacket(cmd, data);
    await device.sendReport(REPORT_ID, pkt);
  }

  // Public API stubs that we can safely implement now ------------------------

  async function getCurrentSlot(_deviceDetails) {
    // Unknown in logs; keep placeholder.
    console.log("USB Device PEQ: Topping getCurrentSlot called - not implemented (default 0).");
    return 0;
  }


// Small helper: wait for echoed state packets and resolve what we need.
  function collectEchoes(device, wantedCmds, ms = 120) {
    return new Promise((resolve) => {
      const found = new Map();
      const onReport = (e) => {
        // Expect reportId === REPORT_ID; ignore others defensively
        if (e.reportId !== REPORT_ID) return;
        const dv = e.data;
        if (dv.byteLength < 5) return;
        const cmd = dv.getUint8(0);
        if (!wantedCmds.includes(cmd)) return;
        const val = dv.getUint32(1, true);
        found.set(cmd, val);
      };
      device.addEventListener("inputreport", onReport);
      const t = setTimeout(() => {
        device.removeEventListener("inputreport", onReport);
        resolve(found);
      }, ms);
      // If you want a manual cancel, return t, but not needed here.
    });
  }

// Translate a single echoed field (cmd,value) into our filter fields
  function decodeFilterResponse(cmd, value) {
    // Identify band index from cmd high nibble: 0x90..0x99
    const page = cmd & 0xF0;        // 0x90 for bands, 0x9C for pregain page
    const low  = cmd & 0x0F;        // field within the page
    const out = {};

    if (page >= 0x90 && page <= 0x99) {
      // Per-band fields we've seen:
      // base+0x06 enable (0/1)
      // base+0x07 freq (Hz)
      // base+0x08 gainSteps (dB * 2)
      // base+0x09 qScaled (Q * 10000)
      if (low === 0x06) out.disabled = (value === 0);
      else if (low === 0x07) out.freq = value;
      else if (low === 0x08) out.gain = value / 2.0;
      else if (low === 0x09) out.q = value / 10000.0;
    }
    return out;
  }

// Best-effort per-band read: poke APPLY then harvest echoes for freq/gain/q/enabled
  async function readFullFilter(device, filterIndex) {
    const base = (0x90 + filterIndex) & 0xFF;

    // 1) Trigger an "echo" of current band state without changing fields:
    //    send APPLY (base+0x0A, data=1). Your logs show the device then echoes 07/08/09 and often 06.
    await sendCmd(device, (base + 0x0A) & 0xFF, 1);

    // 2) Collect echoes for a short window
    const want = [(base + 0x06) & 0xFF, (base + 0x07) & 0xFF, (base + 0x08) & 0xFF, (base + 0x09) & 0xFF];
    const echoes = await collectEchoes(device, want, 150); // ~150ms harvest window

    // 3) Fold them into a filter object with safe defaults
    let freq = 1000;
    let gain = 0;
    let q = 1.0;
    let disabled = false;

    for (const [cmd, val] of echoes.entries()) {
      const partial = decodeFilterResponse(cmd, val);
      if (partial.freq != null) freq = partial.freq;
      if (partial.gain != null) gain = partial.gain;
      if (partial.q != null) q = partial.q;
      if (partial.disabled != null) disabled = partial.disabled;
    }

    return { type: "PK", freq, q, gain, disabled };
  }

// ---------- Pregain (best-guess 16.16 fixed) ----------

  const PREG_PAGE = 0x9C;
  const PREG_SET_A = 0x9C01; // value
  const PREG_TRIG_A = 0x9C02; // 1
  const PREG_SET_B = 0x9C03; // value (repeat/mirror)
  const PREG_TRIG_B = 0x9C04; // 1

// Encode/Decode pregain as signed 16.16 fixed (best guess; tweak if your echoes disagree)
  function encPregainFixed(dB) {
    // clamp to a sensible range to avoid overflow (e.g. -60..+20 dB)
    const clamped = Math.max(-60, Math.min(20, dB));
    // Convert to signed 32-bit
    let fixed = Math.round(clamped * 65536);
    // Bring to unsigned 32 for packing
    return fixed >>> 0;
  }
  function decPregainFixed(val) {
    // Interpret as signed 32
    const signed = (val & 0x80000000) ? (val - 0x100000000) : val;
    return signed / 65536.0;
  }

  async function readPregain(device) {
    // We don't know a "request" opcode; mimic the band trick:
    // send the "trigger" and collect any 0x9C01/0x9C03 echoes briefly.
    // If nothing arrives, return 0 dB.
    await sendCmd(device, PREG_TRIG_A & 0xFF, 1);
    const want = [PREG_SET_A & 0xFF, PREG_SET_B & 0xFF];
    const echoes = await collectEchoes(device, want, 150);

    // Prefer the most-recent SET value we saw (B over A)
    const vB = echoes.get(PREG_SET_B & 0xFF);
    const vA = echoes.get(PREG_SET_A & 0xFF);
    if (vB != null) return decPregainFixed(vB);
    if (vA != null) return decPregainFixed(vA);

    // Fallback: no echo seen
    return 0;
  }

  async function writePregain(device, dB) {
    const fixed = encPregainFixed(dB);
    // Mirror sequence seen in logs (value a?? trigger a?? value a?? trigger)
    await sendCmd(device, PREG_SET_A & 0xFF, fixed);
    await sendCmd(device, PREG_TRIG_A & 0xFF, 1);
    await sendCmd(device, PREG_SET_B & 0xFF, fixed);
    await sendCmd(device, PREG_TRIG_B & 0xFF, 1);
  }

  async function pullFromDevice(deviceDetails) {
    console.log("USB Device PEQ: Topping pullFromDevice (reads mostly placeholders).");
    const device = deviceDetails.rawDevice;
    const filters = [];
    for (let i = 0; i < deviceDetails.modelConfig.maxFilters; i++) {
      filters.push(await readFullFilter(device, i));
    }
    const globalGain = await readPregain(device);
    return { filters, globalGain };
  }

  // NEW: encode + write one filter using the discovered scheme
  async function writeFilter(device, filterIndex, filter) {
    const base = bandBase(filterIndex);
    const enabled = filter.disabled ? 0 : 1;

    // Enable/disable (base+0x06)
    await sendCmd(device, (base + 0x06) & 0xFF, enabled);

    // Frequency (base+0x07) a?? integer Hz
    if (Number.isFinite(filter.freq)) {
      await sendCmd(device, (base + 0x07) & 0xFF, encFreq(filter.freq));
    }

    // Gain (base+0x08) a?? half-dB steps
    if (Number.isFinite(filter.gain)) {
      await sendCmd(device, (base + 0x08) & 0xFF, encGainSteps(filter.gain));
    }

    // Q (base+0x09) a?? Q * 10000
    if (Number.isFinite(filter.q)) {
      await sendCmd(device, (base + 0x09) & 0xFF, encQ(filter.q));
    }

    // Apply/commit (base+0x0A)
    await sendCmd(device, (base + 0x0A) & 0xFF, 1);
  }

  // Build packet function kept for API completeness (we now stream field-wise)
  function buildWritePacket(_filterIndex, _f) {
    // Sending happens per-field; there isn't a single combined packet in this protocol.
    return new Uint8Array([0x00]);
  }

  function buildSavePacket() {
    // Unknown "save-to-flash" opcode; your logs show per-band APPLY (0x..0A). Keeping a no-op.
    return new Uint8Array([0x00]);
  }

  async function pushToDevice(deviceDetails, _slot, globalGain, filters) {
    console.log("USB Device PEQ: Topping pushToDevice (using discovered per-band scheme).");
    const device = deviceDetails.rawDevice;
    const max = Math.min(filters.length, deviceDetails.modelConfig.maxFilters || filters.length);

    for (let i = 0; i < max; i++) {
      const f = filters[i];
      // default to peaking if unspecified
      await writeFilter(device, i, {
        type: f.type ?? "PK",
        freq: f.freq,
        gain: f.gain,
        q: f.q,
        disabled: !!f.disabled,
      });
    }

    // Global pregain (left as a no-op until we finalize 0x9Cxx mapping)
    if (Number.isFinite(globalGain)) {
      await writePregain(device, globalGain);
    }

    // Optional save/commit-to-flash is unknown; per-band commit already sent.
    return false; // don't force disconnect
  }

  async function enablePEQ(_device) {
    // Not observed yet as a single global switch; bands have their own enable flags + per-band apply.
    console.log("USB Device PEQ: Topping enablePEQ - no separate global opcode observed; enabling bands instead.");
  }

  async function readVersion(_device) {
    console.log("USB Device PEQ: Topping readVersion - not yet implemented.");
    return "unknown";
  }

  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice,
    enablePEQ,
    readVersion,
    // optionally expose these for advanced use / tests
    _internal: { bandBase, encFreq, encGainSteps, encQ, writeFilter },
  };
})();
  return toppingUsbHidHandler;
})();

// ==== jdsLabsUsbSerialHandler.js ====
const jdsLabsUsbSerial = (() => {
// jdsLabsUsbSerialHandler.js
// Pragmatic Audio - Handler for JDS Labs Element IV USB Serial EQ Control

class SerialDeviceError extends Error {}

const jdsLabsUsbSerial = (function () {
  const textEncoder = new TextEncoder();
  const textDecoder = new TextDecoder();
  const describeCommand = { Product: "JDS Labs Element IV", Action: "Describe" };

  // Define 12-band filter order
  const FILTER_12_BAND_ORDER = [
    "Lowshelf 1",
    "Lowshelf 2",
    "Peaking 1",
    "Peaking 2",
    "Peaking 3",
    "Peaking 4",
    "Peaking 5",
    "Peaking 6",
    "Peaking 7",
    "Peaking 8",
    "Highshelf 1",
    "Highshelf 2",
  ];


  async function sendJsonCommand(device, json) {
    const writer = device.writable;
    const jsonString = JSON.stringify(json);
    const payload = textEncoder.encode(jsonString + "\0");
    console.log(`USB Device PEQ: JDS Labs sending command:`, jsonString);
    await writer.write(payload);
  }

  async function readJsonResponse(device) {
    const reader = device.readable;
    let buffer = '';
    while (true) {
      const { value, done } = await reader.read();
      if (done || !value) break;
      buffer += textDecoder.decode(value);
      if (buffer.includes("\0")) {
        const jsonStr = buffer.split("\0")[0];
        const response = JSON.parse(jsonStr);
        console.log(`USB Device PEQ: JDS Labs received response:`, response);
        return response;
      }
    }
    console.log(`USB Device PEQ: JDS Labs received no response`);
    return null;
  }

  async function getCurrentSlot(deviceDetails) {
    await sendJsonCommand(deviceDetails, describeCommand);
    const response = await readJsonResponse(deviceDetails);
    if (!response || !response.Configuration || !response.Configuration.General) {
      throw new Error("Invalid Describe response for slot extraction");
    }
    const currentInput = response.Configuration.General["Input Mode"]?.Current;
    return currentInput === "USB" ? 0 : 1; // slot 0 for USB, slot 1 for SPDIF
  }


  // Helper function to get the filter order (always 12-band)
  function getFilterOrder() {
    return FILTER_12_BAND_ORDER;
  }

  // Helper function to transform JDS Labs filter types to standard format
  function transformFilterType(jdsLabsType) {
    switch (jdsLabsType) {
      case "LOWSHELF":
        return "LSQ";
      case "HIGHSHELF":
        return "HSQ";
      case "PEAKING":
        return "PK";
      default:
        return "PK"; // Default to peaking
    }
  }

  async function pullFromDevice(deviceDetails, slot) {
    await sendJsonCommand(deviceDetails, describeCommand);
    const response = await readJsonResponse(deviceDetails);
    if (!response || !response.Configuration || !response.Configuration.DSP) {
      throw new Error("Invalid Describe response for PEQ extraction");
    }

    console.log(`USB Device PEQ: JDS Labs device (12-band support only)`);

    const headphoneConfig = response.Configuration.DSP.Headphone;
    const filters = [];
    const filterNames = getFilterOrder();

    // Count actual filters available from the device
    let actualFilterCount = 0;
    for (const name of filterNames) {
      if (headphoneConfig[name]) {
        actualFilterCount++;
      }
    }

    // Show toast notification if fewer than 12 filters are detected
    if (actualFilterCount < 12) {
      console.log(`USB Device PEQ: JDS Labs detected only ${actualFilterCount} filters, showing firmware update notification`);
      if (typeof window !== 'undefined' && window.showToast) {
        window.showToast(
          `Only ${actualFilterCount} of 12 filters detected. Please update your JDS Labs Element IV firmware to the latest version for full 12-band EQ support.`,
          'warning',
          8000
        );
      }
    }

    for (const name of filterNames) {
      const filter = headphoneConfig[name];
      if (!filter) {
        console.log(`USB Device PEQ: JDS Labs missing filter ${name}, using default values`);
        // Add default values for missing filters
        const defaultType = name.startsWith("Lowshelf") ? "LOWSHELF" :
                           name.startsWith("Highshelf") ? "HIGHSHELF" : "PEAKING";
        filters.push({
          freq: name.startsWith("Lowshelf") ? 80 : name.startsWith("Highshelf") ? 10000 : 1000,
          gain: 0,
          q: 0.707,
          type: transformFilterType(defaultType)
        });
        continue;
      }

      // Use full type names for consistency
      let filterType = "PEAKING"; // Default to PEAKING
      if (filter.Type) {
        filterType = filter.Type.Current || "PEAKING";
      }

      filters.push({
        freq: filter.Frequency.Current,
        gain: filter.Gain.Current,
        q: filter.Q.Current,
        type: transformFilterType(filterType)
      });
    }

    const preampGain = headphoneConfig.Preamp?.Gain?.Current || 0;

    return { filters, globalGain: preampGain };
  }

  // Helper function to group and validate filters for JDS Labs
  function groupAndValidateFilters(filters) {
    const JDS_LIMITS = {
      LSQ: 2,    // 2 Lowshelf filters
      HSQ: 2,    // 2 Highshelf filters
      PK: 8      // 8 Peaking filters
    };

    // Group filters by type
    const grouped = {
      LSQ: filters.filter(f => f.type === 'LSQ'),
      HSQ: filters.filter(f => f.type === 'HSQ'),
      PK: filters.filter(f => f.type === 'PK')
    };

    const warnings = [];
    const validatedFilters = {
      LSQ: [],
      HSQ: [],
      PK: []
    };

    // Validate and truncate each group
    for (const [type, typeFilters] of Object.entries(grouped)) {
      const limit = JDS_LIMITS[type];

      if (typeFilters.length > limit) {
        warnings.push(`Warning: JDS Labs only supports ${limit} ${type === 'LSQ' ? 'Low Shelf' : type === 'HSQ' ? 'High Shelf' : 'Peak'} filters, but ${typeFilters.length} were provided. Only the first ${limit} will be applied.`);
        validatedFilters[type] = typeFilters.slice(0, limit);
      } else {
        validatedFilters[type] = typeFilters;
      }
    }

    // Show warnings if any
    if (warnings.length > 0) {
      warnings.forEach(warning => {
        console.warn(`USB Device PEQ: JDS Labs - ${warning}`);
        if (typeof window !== 'undefined' && window.showToast) {
          window.showToast(warning, "warning", 8000);
        }
      });
    }

    // Create aligned filter array for JDS Labs 12-band structure
    const alignedFilters = [];

    // Add Lowshelf filters (positions 0-1)
    for (let i = 0; i < 2; i++) {
      if (i < validatedFilters.LSQ.length) {
        alignedFilters.push({...validatedFilters.LSQ[i], type: 'LOWSHELF'});
      } else {
        // Add disabled/default lowshelf filter
        alignedFilters.push({freq: 80, gain: 0, q: 0.707, type: 'LOWSHELF'});
      }
    }

    // Add Peaking filters (positions 2-9)
    for (let i = 0; i < 8; i++) {
      if (i < validatedFilters.PK.length) {
        alignedFilters.push({...validatedFilters.PK[i], type: 'PEAKING'});
      } else {
        // Add disabled/default peaking filter
        alignedFilters.push({freq: 1000, gain: 0, q: 0.707, type: 'PEAKING'});
      }
    }

    // Add Highshelf filters (positions 10-11)
    for (let i = 0; i < 2; i++) {
      if (i < validatedFilters.HSQ.length) {
        alignedFilters.push({...validatedFilters.HSQ[i], type: 'HIGHSHELF'});
      } else {
        // Add disabled/default highshelf filter
        alignedFilters.push({freq: 10000, gain: 0, q: 0.707, type: 'HIGHSHELF'});
      }
    }

    return alignedFilters;
  }

  async function pushToDevice(deviceDetails, slot, globalGain, filters) {

    console.log(`USB Device PEQ: JDS Labs building settings for 12-band device`);

    // Group and validate filters according to JDS Labs requirements
    const alignedFilters = groupAndValidateFilters(filters);

    // Create filter object with Type field (always 12-band)
    const makeFilterObj = (filter, defaultType = "PEAKING") => {
      // Device expects full type names, not abbreviated forms
      const currentType = filter.type || defaultType;

      return {
        Gain: filter.gain,
        Frequency: filter.freq,
        Q: filter.q,
        Type: currentType
      };
    };

    // Get the filter order (always 12-band)
    const filterOrder = getFilterOrder();

    // Create the headphone configuration object
    const headphoneConfig = {
      Preamp: { Gain: globalGain, Mode: "AUTO" }
    };

    // Add aligned filters to the configuration (alignedFilters already has correct types and positions)
    filterOrder.forEach((name, index) => {
      if (index < alignedFilters.length) {
        headphoneConfig[name] = makeFilterObj(alignedFilters[index]);
      } else {
        // This shouldn't happen since alignedFilters should always be 12 elements
        console.warn(`USB Device PEQ: JDS Labs missing filter at index ${index}`);
      }
    });

    const payload = {
      Product: "JDS Labs Element IV",
      FormatOutput: true,
      Action: "Update",
      Configuration: {
        DSP: {
          Headphone: headphoneConfig
        }
      }
    };

    await sendJsonCommand(deviceDetails, payload);
    const response = await readJsonResponse(deviceDetails);
    if (response["Status"] === true) {
      console.log("Settings Applied & Saved");
      return response;
    } else {
      throw new SerialDeviceError("Command error updating settings");
    }
  }


  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice, // Kept for backward compatibility
    enablePEQ: async () => {} // Not applicable for JDSLabs
  };
})();
  return jdsLabsUsbSerial;
})();

// ==== nothingUsbSerialHandler.js ====
const nothingUsbSerial = (() => {
// nothingUsbSerialHandler.js
// Pragmatic Audio - Handler for Nothing Headphones USB Serial/Bluetooth SPP EQ Control

const nothingUsbSerial = (function () {

  // Nothing headphone protocol constants
  const PROTOCOL_HEADER = [0x55, 0x60, 0x01, 0x00, 0x00, 0x00, 0x00, 0x00];

  // Command constants from bluetooth-spp-test.html
  // READ_ commands - used to send() values to the SSP port
  const READ_COMMANDS = {
    READ_EQ_MODE: 49183,
    READ_EQ_VALUES: 49229,
    READ_FIRMWARE: 49218
  };

  // WRITE_ commands - used to send() values to the SSP port
  const WRITE_COMMANDS = {
    SET_ADVANCE_CUSTOM_EQ_VALUE: 61520
  };

  // RESPONSE_ commands - used to read the results of either READ_ or WRITE_ operations
  const RESPONSE_COMMANDS = {
    EQ_MODE: 16415, // Response for READ_EQ_MODE command
    FIRMWARE: 16450,
    EQ_VALUES: 16461
  };


  let operationID = 0;
  let operationList = {};

  function crc16(buffer) {
    let crc = 0xFFFF;
    for (let i = 0; i < buffer.length; i++) {
      crc ^= buffer[i];
      for (let j = 0; j < 8; j++) {
        crc = (crc & 1) ? ((crc >> 1) ^ 0xA001) : (crc >> 1);
      }
    }
    return crc;
  }

  async function sendCommand(device, command, payload = [], operation = "") {
    let header = [...PROTOCOL_HEADER];
    operationID++;
    header[7] = operationID;

    let commandBytes = new Uint8Array(new Uint16Array([command]).buffer);
    header[3] = commandBytes[0];
    header[4] = commandBytes[1];

    let payloadLength = payload.length;
    header[5] = payloadLength;
    header.push(...payload);

    let byteArray = new Uint8Array(header);
    let crc = crc16(byteArray);
    byteArray = [...byteArray, crc & 0xFF, crc >> 8];

    if (operation !== "") {
      operationList[operationID] = operation;
    }

    console.log(`Nothing USB Serial: sending command ${command}:`, byteArray.map(byte => byte.toString(16).padStart(2, '0')).join(''));

    const writer = device.writable;
    await writer.write(new Uint8Array(byteArray));
  }

  function getCommand(header) {
    let commandBytes = new Uint8Array(header.slice(3, 5));
    let commandInt = new Uint16Array(commandBytes.buffer)[0];
    return commandInt;
  }

  function bytesToFloat(byteArray) {
    const buffer = new ArrayBuffer(4);
    const view = new Uint8Array(buffer);
    for (let i = 0; i < 4; i++) {
      view[i] = byteArray[i];
    }
    const dataView = new DataView(buffer);
    return dataView.getFloat32(0, true); // true for little-endian
  }

  function floatToBytes(value) {
    const buffer = new ArrayBuffer(4);
    const view = new DataView(buffer);
    view.setFloat32(0, value, true); // true for little-endian
    return new Uint8Array(buffer);
  }

  function toByteArray(value, offset = 0, length = 1) {
    const byteArray = new Uint8Array(length);

    if (length === 1) {
      byteArray[0] = value & 0xFF;
    } else if (length === 2) {
      byteArray[0] = value & 0xFF;
      byteArray[1] = (value >> 8) & 0xFF;
    } else if (length === 4) {
      byteArray[0] = value & 0xFF;
      byteArray[1] = (value >> 8) & 0xFF;
      byteArray[2] = (value >> 16) & 0xFF;
      byteArray[3] = (value >> 24) & 0xFF;
    } else {
      byteArray[0] = value & 0xFF;
    }

    return Array.from(byteArray);
  }

  async function readResponse(device) {
    const reader = device.readable;
    const { value, done } = await reader.read();

    if (done || !value) {
      return null;
    }

    let rawData = new Uint8Array(value.buffer);
    if (rawData[0] !== 0x55 || rawData.length < 8) {
      return null;
    }

    // Use full 8-byte protocol header to align payload offset correctly
    let header = rawData.slice(0, 8);
    let command = getCommand(header);

    return {
      command,
      rawData,
      hexString: rawData.reduce((acc, byte) => acc + byte.toString(16).padStart(2, '0'), '')
    };
  }

  async function readEQMode(device) {
    console.log("Nothing USB Serial: reading current EQ mode");
    await sendCommand(device, READ_COMMANDS.READ_EQ_MODE, [], "readEQMode");

    const response = await readResponse(device);
    if (!response || response.command !== RESPONSE_COMMANDS.EQ_MODE) {
      throw new Error("Failed to read EQ mode from Nothing device");
    }

    // Parse EQ mode response
    const hexArray = response.hexString.match(/.{2}/g).map(byte => parseInt(byte, 16));
    const eqModeValue = hexArray[8]; // EQ mode is typically at offset 8

    return eqModeValue;
  }

  async function getCurrentSlot(deviceDetails) {
    try {
      return await readEQMode(deviceDetails);
    } catch (error) {
      console.error("Nothing USB Serial: failed to read current EQ mode:", error);
      return 0; // Default to Balanced profile
    }
  }

  function getProfileName(deviceDetails, profileId) {
    const slots = deviceDetails?.modelConfig?.availableSlots;
    if (Array.isArray(slots)) {
      const match = slots.find(s => s.id === profileId);
      if (match && match.name) return match.name;
    }
    // Removed hardcoded fallback; rely on config-provided names
    return `Slot ${profileId}`;
  }

  async function pullFromDevice(deviceDetails, slot) {
    console.log(`Nothing USB Serial: pulling EQ from device slot ${slot}`);

    // First, read the current EQ mode to determine which profile is active
    let currentProfile = slot;
    try {
      currentProfile = await readEQMode(deviceDetails);
      console.log(`Nothing USB Serial: detected active profile ${currentProfile}`);
    } catch (error) {
      console.warn(`Nothing USB Serial: could not read EQ mode, using requested slot ${slot}`);
      currentProfile = slot;
    }

    // For profiles that are not the first writable EQ slot, we can only read basic EQ settings
    const firstWritableSlot = deviceDetails?.modelConfig?.firstWritableEQSlot ?? 5;
    // we can only read basic EQ settings - these don't have detailed parametric EQ data
    if (currentProfile !== firstWritableSlot) {
      const profileName = getProfileName(deviceDetails, currentProfile);
      console.log(`Nothing USB Serial: reading basic EQ for profile ${currentProfile} (${profileName})`);

      return {
        filters: [], // Basic profiles don't expose individual filters
        globalGain: 0,
        profileId: currentProfile,
        profileName: profileName,
        isBasicProfile: true
      };
    }

    // For Custom profile (first writable slot), read detailed EQ values
    const customProfileName = getProfileName(deviceDetails, firstWritableSlot);
    console.log(`Nothing USB Serial: reading EQ values for ${customProfileName} profile ${currentProfile}`);
    const payload = toByteArray(0, 0, 1);
    await sendCommand(deviceDetails, READ_COMMANDS.READ_EQ_VALUES, payload, "readEQValues");

    // Read response
    const response = await readResponse(deviceDetails);
    if (!response || response.command !== RESPONSE_COMMANDS.EQ_VALUES) {
      throw new Error("Failed to read EQ values from Nothing device");
    }

    // Parse EQ values response - based on readEQValues() from HTML
    const hexArray = response.hexString.match(/.{2}/g).map(byte => parseInt(byte, 16));

    if (hexArray.length < 10) {
      throw new Error("EQ Values response too short");
    }

    let offset = 8; // Skip 8-byte protocol header

    const profileIndex = hexArray[offset++];
    const numBands = hexArray[offset++];

    // Total gain (4 bytes as float, little-endian)
    const totalGainBytes = hexArray.slice(offset, offset + 4);
    const totalGain = bytesToFloat(totalGainBytes);
    offset += 4;

    const filters = [];

    // Parse each EQ band (13 bytes each)
    for (let i = 0; i < numBands && offset + 12 < hexArray.length; i++) {
      const filterType = hexArray[offset++];

      const gainBytes = hexArray.slice(offset, offset + 4);
      const gain = Math.round(bytesToFloat(gainBytes) * 100)/100;
      offset += 4;

      const freqBytes = hexArray.slice(offset, offset + 4);
      const frequency = bytesToFloat(freqBytes);
      offset += 4;

      const qualityBytes = hexArray.slice(offset, offset + 4);
      const quality = bytesToFloat(qualityBytes);
      const qFactorValue = Math.round(quality * 100)/100;
      offset += 4;

      filters.push({
        freq: frequency,
        gain: gain,
        q: qFactorValue,
        type: filterType === 0 ? "LSQ" : filterType === 2 ? "HSQ" : "PK"
      });
    }

    const profileName = getProfileName(deviceDetails, currentProfile);
    console.log(`Nothing USB Serial: pulled ${filters.length} filters with global gain ${totalGain} for ${profileName}`);
    return {
      filters,
      globalGain: totalGain,
      profileId: currentProfile,
      profileName: profileName,
      isBasicProfile: false
    };
  }

  function createEQDataPacket(profileIndex, eqBands, totalGain = 0.0) {
    // Based on Java obtainDataPacket() method
    const numBands = eqBands ? eqBands.length : 0;
    const packetSize = 1 + 1 + 4 + (numBands * 13); // profileIndex + numBands + totalGain + (bands * 13 bytes each)

    const packet = new Uint8Array(packetSize);
    let offset = 0;

    // Profile index (1 byte)
    packet[offset++] = profileIndex;

    // Number of bands (1 byte)
    packet[offset++] = numBands;

    // Total gain (4 bytes as float, little-endian)
    const totalGainBytes = floatToBytes(totalGain);
    packet.set(totalGainBytes, offset);
    offset += 4;

    // EQ bands data
    if (eqBands) {
        for (const band of eqBands) {
            // Filter type (1 byte)
            packet[offset++] = band.filterType; // Default to PEAK

            // Gain (4 bytes as float)
            const gainBytes = floatToBytes(band.gain || 0.0);
            packet.set(gainBytes, offset);
            offset += 4;

            // Frequency (4 bytes as float)
            const freqBytes = floatToBytes(band.frequency || 1000.0);
            packet.set(freqBytes, offset);
            offset += 4;

            // Quality (4 bytes as float)
            const qualityBytes = floatToBytes(band.quality || 0.707);
            packet.set(qualityBytes, offset);
            offset += 4;
        }
    }

    return packet;
  }

  async function pushToDevice(deviceDetails, slot, globalGain, filters) {
    console.log(`Nothing USB Serial: pushing ${filters.length} filters to device slot ${slot}`);

    // Only the first writable slot supports writing EQ values
    const firstWritableSlot = deviceDetails?.modelConfig?.firstWritableEQSlot ?? 5;
    if (slot !== firstWritableSlot) {
      const name = getProfileName(deviceDetails, firstWritableSlot);
      throw new Error(`EQ writing only supported for ${name} (slot ${firstWritableSlot}), requested slot: ${slot}`);
    }

    // Convert filters to the format expected by createEQDataPacket
    const eqBands = filters.map(filter => ({
      filterType: filter.type === "LSQ" ? 0 : filter.type === "HSQ" ? 2 : 1, // PEAKING = 1
      gain: filter.gain,
      frequency: filter.freq,
      quality: filter.q
    }));

    // Create EQ data packet using the provided logic
    const packet = createEQDataPacket(0, eqBands, globalGain); // profileIndex 0 for Custom
    const payload = Array.from(packet);

    console.log(`Nothing USB Serial: writing Custom EQ with ${filters.length} filters and global gain ${globalGain}`);
    await sendCommand(deviceDetails, WRITE_COMMANDS.SET_ADVANCE_CUSTOM_EQ_VALUE, payload, "writeEQValues");

    // Wait for response to confirm write was successful
    const response = await readResponse(deviceDetails);
    if (!response) {
      throw new Error("No response received after writing EQ values");
    }

    console.log(`Nothing USB Serial: EQ values written successfully to Custom profile`);
  }

  async function enablePEQ(device, enabled, slotId) {
    // Nothing headphones don't have a separate PEQ enable/disable command
    console.log(`Nothing USB Serial: PEQ enable/disable not applicable`);
  }

  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice,
    enablePEQ
  };
})();
  return nothingUsbSerial;
})();

// ==== fiioUsbSerialHandler.js ====
const fiioUsbSerial = (() => {
// fiioUsbSerialHandler.js
// Pragmatic Audio - Handler for FiiO USB Serial EQ Control

// Header constants - matching fiioUsbHidHandler.js for compatibility
const SET_HEADER1 = 0xAA;
const SET_HEADER2 = 0x0A;
const GET_HEADER1 = 0xBB;
const GET_HEADER2 = 0x0B;
const END_HEADERS = 0xEE;

// PEQ command constants - matching fiioUsbHidHandler.js for compatibility
const PEQ_FILTER_COUNT = 0x18; // 24 in hex
const PEQ_GLOBAL_GAIN = 0x17; // 23 in hex
const PEQ_FILTER_PARAMS = 0x15; // 21 in hex
const PEQ_PRESET_SWITCH = 0x16; // 22 in hex
const PEQ_SAVE_TO_DEVICE = 0x19; // 25 in hex
const PEQ_RESET_DEVICE = 0x1B; // 27 in hex
const PEQ_RESET_ALL = 0x1C; // 28 in hex

// Note these have different headers
const PEQ_FIRMWARE_VERSION = 0x0B; // 11 in hex
const PEQ_NAME_DEVICE = 0x30; // 48 in hex

class SerialDeviceError extends Error {}

const fiioUsbSerial = (function () {

  // Helper function to send data and listen for response using device streams
  let __serialIsSending = false;
  async function sendReportAndListen(device, data, endByte = END_HEADERS) {
    if (__serialIsSending) throw new Error("Port is busy");
    __serialIsSending = true;

    const port = device.rawDevice;
    if (!port || !port.readable || !port.writable) {
      __serialIsSending = false;
      throw new Error("Serial port not available");
    }

    let writer = null;
    let reader = null;
    const buffer = [];
    const overallTimeoutMs = 5000;
    const startedAt = Date.now();
    let timerId = null;

    // Track expected total frame length once we have the header and LEN byte
    let expectedTotal = null; // bytes

    try {
      // Acquire writer per call, write, then release (replicating reference write())
      writer = port.writable.getWriter();
      await writer.write(data);
      try { writer.releaseLock(); } catch (_) {}

      // Acquire reader per call and read until done/terminator/timeout (replicating reference read())
      reader = port.readable.getReader();

      await Promise.all([
        Promise.resolve(),
        (async () => {
          while (true) {
            const elapsed = Date.now() - startedAt;
            if (elapsed >= overallTimeoutMs) return; // stop reading on overall timeout

            const remaining = overallTimeoutMs - elapsed;
            const race = await Promise.race([
              reader.read(),
              new Promise((_, reject) => {
                timerId = setTimeout(() => {
                  // cancel in-flight read to unblock
                  reader.cancel().catch(() => {});
                  reject(new Error("Timeout"));
                }, remaining);
              })
            ]);

            const { value, done } = race;
            if (done) break;
            const chunk = Array.from(value || []);
            if (chunk.length > 0) {
              buffer.push(...chunk);

              // Determine expected total frame length once we have at least 6 bytes
              if (expectedTotal == null && buffer.length >= 6) {
                const len = buffer[5] || 0; // LEN field
                // Frame layout: [H1,H2,0,0,CMD,LEN, (LEN data...), 0, END]
                expectedTotal = 6 + len + 2; // bytes
              }

              // If we already know how long the frame should be, only stop once all bytes are in
              if (expectedTotal != null && buffer.length >= expectedTotal) {
                // Only accept if the last byte is the terminator; otherwise keep reading
                if (buffer[expectedTotal - 1] === endByte) {
                  // Trim any extra bytes beyond expectedTotal (shouldn't happen often)
                  buffer.splice(expectedTotal);
                  return;
                }
              }
            }
            clearTimeout(timerId); // clear per-iteration timer
            timerId = null;
          }
        })()
      ]);

      return buffer.length > 0 ? new Uint8Array(buffer) : new Uint8Array(0);
    } catch (e) {
      if (e && e.message === "Timeout") {
        // On timeout, return empty buffer like original
        return new Uint8Array(0);
      }
      throw e;
    } finally {
      if (timerId) clearTimeout(timerId);
      try { if (reader) reader.releaseLock(); } catch (_) {}
      __serialIsSending = false;
    }
  }


  // Helper function to create command bytes
  function createCommandPacket(header1, header2, command, data = []) {
    const packet = [header1, header2, 0, 0, command];
    if (data.length > 0) {
      packet.push(data.length);
      packet.push(...data);
      // Reserved byte before terminator in examples
      packet.push(0);
    } else {
      packet.push(0, 0);
    }
    packet.push(END_HEADERS); // End header
    return new Uint8Array(packet);
  }

  // Helper function to convert string to byte array
  function stringToByteArray(str) {
    return Array.from(str, char => char.charCodeAt(0));
  }

  // Command functions for FiiO USB protocol - matching HID handler constants
  const createGetEqCountCmd = () => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_FILTER_COUNT);
  const createSetEqBandWithNameCmd = (bandIndex, name) => createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_NAME_DEVICE, [bandIndex, ...stringToByteArray(name.padEnd(8, "\0").slice(0, 8))]);
  const createGetEqBandCmd = bandIndex => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_FILTER_PARAMS, [bandIndex]);
  const createSetEqBandCmd = bandIndex => createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_FILTER_PARAMS, [bandIndex]);
  const createGetEqPresetCmd = () => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_PRESET_SWITCH);
  const createGetGlobalGainCmd = () => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_GLOBAL_GAIN);
  const createSetGlobalGainCmd = gain => {
    // Encode gain in tenths (0.1 dB) as two bytes (signed big-endian)
    const value = Math.round(gain * 10);
    const v16 = ((value % 0x10000) + 0x10000) % 0x10000;
    const hi = (v16 >> 8) & 0xFF;
    const lo = v16 & 0xFF;
    return createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_GLOBAL_GAIN, [hi, lo]);
  };
  const createSetEqPresetCmd = presetValue => createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_PRESET_SWITCH, [presetValue & 0xFF]);
  const createGetEqStatusCmd = () => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_FILTER_COUNT);
  const createGetDeviceInfoCmd = () => createCommandPacket(GET_HEADER1, GET_HEADER2, PEQ_FIRMWARE_VERSION);
  const createResetEqCmd = () => createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_RESET_DEVICE);

  // Helper functions for data parsing
  function parseGain(byte1, byte2) {
    // Signed 16-bit big-endian, tenths (0.1 dB units)
    let v = ((byte1 << 8) | byte2) & 0xFFFF;
    if (v & 0x8000) v = v - 0x10000;
    return v / 10.0;
  }

  function parseQValue(byte1, byte2) {
    // Unsigned 16-bit big-endian, hundredths
    const v = ((byte1 << 8) | byte2) & 0xFFFF;
    return v / 100.0;
  }

  // Encoding helpers
  function encodeSignedHundredths(value) {
    // For gain: device uses tenths (0.1 dB)
    const v = Math.round(value * 10);
    const v16 = ((v % 0x10000) + 0x10000) % 0x10000;
    return [(v16 >> 8) & 0xFF, v16 & 0xFF];
  }
  function encodeUnsignedHundredths(value) {
    const v = Math.round(value * 100);
    const v16 = v & 0xFFFF;
    return [(v16 >> 8) & 0xFF, v16 & 0xFF];
  }

  // Full-band set command: [index, gain_hi, gain_lo, freq_hi, freq_lo, q_hi, q_lo, type]
  function createSetEqBandCommand(bandIndex, frequency, gain, qValue, filterType) {
    const [gHi, gLo] = encodeSignedHundredths(gain);
    const freq = Math.round(frequency) & 0xFFFF;
    const fHi = (freq >> 8) & 0xFF;
    const fLo = freq & 0xFF;
    const [qHi, qLo] = encodeUnsignedHundredths(qValue);
    const data = [bandIndex & 0xFF, gHi, gLo, fHi, fLo, qHi, qLo, (filterType ?? 0) & 0xFF];
    return createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_FILTER_PARAMS, data);
  }

  // EQ switch (on/off)
  const createSetEqSwitchCommand = (enabled) => createCommandPacket(SET_HEADER1, SET_HEADER2, 0x1A, [enabled ? 1 : 0]);

  // Set preset (pre = 0x16)
  const createSetEqPreCommand = (presetValue) => createCommandPacket(SET_HEADER1, SET_HEADER2, PEQ_PRESET_SWITCH, [presetValue & 0xFF]);

  // Main handler functions
  async function getCurrentSlot(deviceDetails) {
    try {
      // Get current EQ preset
      const cmd = createGetEqPresetCmd();
      try { console.debug('[FiiO Serial] SEND get preset:', Array.from(cmd)); } catch (_) {}
      const response = await sendReportAndListen(deviceDetails, cmd);
      try { console.debug('[FiiO Serial] RECV get preset:', Array.from(response)); } catch (_) {}
      if (response.length > 6) {
        return response[6]; // Assuming preset ID is at byte 6
      }
      return 0;
    } catch (error) {
      console.error("Failed to get current slot:", error);
      throw error;
    }
  }

  async function pullFromDevice(deviceDetails, slot) {
    try {
      // Get EQ count
      const countResponse = await sendReportAndListen(deviceDetails, createGetEqCountCmd());
      let eqCount = 0;
      if (countResponse.length > 6) {
        eqCount = countResponse[6];
        if (eqCount === 0) {
          throw new Error("No PEQ band found.");
        }
      }

      // Get global gain
      const gainResponse = await sendReportAndListen(deviceDetails, createGetGlobalGainCmd());
      let eqGlobalGain = 0;
      if (gainResponse.length > 7) {
        eqGlobalGain = parseGain(gainResponse[6], gainResponse[7]);
      }

      // Get EQ bands
      const filters = [];
      for (let i = 0; i < eqCount; i++) {
        const bandResponse = await sendReportAndListen(deviceDetails, createGetEqBandCmd(i));
        if (bandResponse.length >= 14) {
          // Data layout: [index, gain_hi, gain_lo, freq_hi, freq_lo, q_hi, q_lo, type]
          const gain = parseGain(bandResponse[7], bandResponse[8]);
          const frequency = (bandResponse[9] << 8) | bandResponse[10];
          const qValue = parseQValue(bandResponse[11], bandResponse[12]);
          const filterType = bandResponse[13];

          // Convert FiiO filter type to standard format
          let type = "PK";
          switch (filterType) {
            case 0: type = "PK"; break;
            case 1: type = "LSQ"; break;
            case 2: type = "HSQ"; break;
            default: type = "PK"; break;
          }

          filters.push({
            freq: frequency,
            gain: gain,
            q: qValue,
            type: type
          });
        }
      }

      // Sort filters by frequency
      filters.sort((a, b) => a.freq - b.freq);

      return {
        filters: filters,
        globalGain: eqGlobalGain
      };

    } catch (error) {
      console.error("Failed to pull data from FiiO device:", error);
      throw error;
    }
  }

  async function pushToDevice(deviceDetails, slot, globalGain, filters) {
    try {
      // Set global gain
      await sendReportAndListen(deviceDetails, createSetGlobalGainCmd(globalGain));

      // Set each EQ band
      for (let i = 0; i < filters.length; i++) {
        const filter = filters[i];

        // Convert filter type to FiiO format
        let filterType = 0; // Default to peaking (PK)
        switch (filter.type) {
          case "PK": filterType = 0; break;
          case "LSQ": filterType = 1; break;
          case "HSQ": filterType = 2; break;
        }

        await sendReportAndListen(deviceDetails,
          createSetEqBandCommand(i, filter.freq, filter.gain, filter.q, filterType)
        );
      }

      console.log("FiiO settings applied successfully");
      // Return whether we should disconnect after saving, mirroring HID handler behavior
      return !!(deviceDetails && deviceDetails.modelConfig && deviceDetails.modelConfig.disconnectOnSave);

    } catch (error) {
      console.error("Failed to push data to FiiO device:", error);
      throw error;
    }
  }

  async function enablePEQ(deviceDetails, enable, slotId) {
    try {
      if (enable) {
        // Enable EQ and set to specified slot/preset
        await sendReportAndListen(deviceDetails, createSetEqSwitchCommand(1));
        if (slotId !== undefined) {
          await sendReportAndListen(deviceDetails, createSetEqPreCommand(slotId));
        }
      } else {
        // Disable EQ
        await sendReportAndListen(deviceDetails, createSetEqSwitchCommand(0));
      }

      console.log(`FiiO EQ ${enable ? 'enabled' : 'disabled'}`);

    } catch (error) {
      console.error("Failed to enable/disable FiiO EQ:", error);
      throw error;
    }
  }

  // Return the handler interface
  return {
    getCurrentSlot,
    pullFromDevice,
    pushToDevice,
    enablePEQ
  };
})();
  return fiioUsbSerial;
})();

// ==== wiimNetworkHandler.js ====
const wiimNetworkHandler = (() => {
//
// Copyright 2024 : Pragmatic Audio
//
// Define the WiiM Network Handler for PEQ over HTTP API
//

const PLUGIN_URI = "http://moddevices.com/plugins/caps/EqNp";

const wiimNetworkHandler = (function () {

  /**
   * Fetch PEQ settings from the device
   * @param {string} ip - The device IP address
   * @param {number} slot - The PEQ slot (currently not used in WiiM API)
   * @returns {Promise<Object>} The parsed EQ settings
   */
  async function pullFromDevice(ip, slot) {
    try {
      const payload = {
        source_name: SOURCE_NAME,
        pluginURI: PLUGIN_URI
      };
      const url = `https://${ip}/httpapi.asp?command=EQGetLV2SourceBandEx:${encodeURIComponent(JSON.stringify(payload))}`;
      console.log(`Device PEQ: WiiM sending request to fetch EQ data:`, payload);

      const response = await fetch(url, {method: "GET", mode: "no-cors"});

      if (!response.status)
        throw new Error(`Failed to fetch PEQ data: ${response.status}`);

      const data = await response.json();
      if (data.status !== "OK") throw new Error(`PEQ fetch failed: ${JSON.stringify(data)}`);

      console.log("Device PEQ: WiiM received EQ data:", data);

      const filters = parseWiiMEQData(data);
      return {filters, globalGain: 0, currentSlot: slot, deviceDetails: {maxFilters: 10}};

    } catch (error) {
      console.error("Error pulling PEQ settings from WiiM:", error);
      throw error;
    }
  }

  /**
   * Push PEQ settings to the device
   * @param {string} ip - The device IP address
   * @param {number} slot - The PEQ slot (currently not used in WiiM API)
   * @param {number} preamp - The preamp gain
   * @param {Array} filters - Array of PEQ filters
   * @returns {Promise<boolean>} Returns true if push was successful
   */
  async function pushToDevice(ip, slot, preamp, filters) {
    try {
      const eqBandData = filters.map((filter, index) => ({
        param_name: `${String.fromCharCode(97 + index)}_mode`,
        value: filter.disabled ? -1 : convertToWiimMode(filter.type),
      }));

      filters.forEach((filter, index) => {
        eqBandData.push(
          {
            param_name: `${String.fromCharCode(97 + index)}_freq`,
            value: filter.freq
          },
          {
            param_name: `${String.fromCharCode(97 + index)}_q`,
            value: filter.q
          },
          {
            param_name: `${String.fromCharCode(97 + index)}_gain`,
            value: filter.gain
          }
        );
      });

      const payload = {
        pluginURI: PLUGIN_URI,           // e.g., "http://moddevices.com/plugins/caps/EqNp"
        source_name: "wifi",             // or "bt", "line_in", etc. Always Wifi for now
        EQBand: eqBandData,
        EQStat: "On",                    // Enable EQ
        channelMode: "Stereo",          // Use stereo mode
      };

      const url = `https://${ip}/httpapi.asp?command=EQSetLV2SourceBand:${encodeURIComponent(JSON.stringify(payload))}`;
      console.log(`Device PEQ: WiiM sending request to set EQ data:`, payload);

      const response = await fetch(url, { method: "GET", mode: "no-cors" });

      if (response.status != 0)
        throw new Error(`Failed to push PEQ data: ${response.status}`);

      if (response.type !== "opaque") {
        const data = await response.json();
        console.log(`Device PEQ: WiiM received response for set EQ:`, data);
        if (data.status !== "OK")
          throw new Error(`PEQ push failed: ${JSON.stringify(data)}`);
      } else {
        console.log("Device PEQ: WiiM cannot read response due to security reasons (CORS)");
      }

      // Now set the Preset Name - ultimately get the headphone name from custom parameters but not for now
      const presetNamePayload = {
        pluginURI: PLUGIN_URI,           // e.g., "http://moddevices.com/plugins/caps/EqNp"
        source_name: "wifi",             // or "bt", "line_in", etc.
        Name: "HeadphoneEQ"             // Custom preset name
      }
      const presetNameUrl = `https://${ip}/httpapi.asp?command=EQSourceSave:${encodeURIComponent(JSON.stringify(presetNamePayload))}`;
      console.log(`Device PEQ: WiiM sending request to save preset name:`, presetNamePayload);

      const presetNameResponse = await fetch(presetNameUrl, { method: "GET", mode: "no-cors" });

      if (presetNameResponse.status != 0)
        throw new Error(`Failed to push PEQ data: ${presetNameResponse.status}`);

      if (presetNameResponse.type !== "opaque") {
        const data = await presetNameResponse.json();
        console.log(`Device PEQ: WiiM received response for preset name:`, data);
        if (data.status !== "OK")
          throw new Error(`PEQ Name push failed: ${JSON.stringify(data)}`);
      } else {
        console.log("Device PEQ: WiiM cannot read preset name response due to security reasons (CORS)");
      }

      console.log("Device PEQ: WiiM settings successfully pushed to device");


      console.log("WiiM PEQ updated successfully");
      return false; // We don't need to restart

    } catch (error) {
      console.error("Error pushing PEQ settings to WiiM:", error);
      throw error;
    }
  }

  /**
   * Enable or disable PEQ
   * @param {string} ip - The device IP address
   * @param {boolean} enabled - Whether to enable or disable PEQ
   * @param {number} slotId - The PEQ slot (currently not used in WiiM API)
   * @returns {Promise<void>}
   */
  async function enablePEQ(ip, enabled, slotId) {
    try {
      const command = enabled ? "EQChangeSourceFX" : "EQSourceOff";
      const payload = {source_name: SOURCE_NAME, pluginURI: PLUGIN_URI};
      const url = `https://${ip}/httpapi.asp?command=${command}:${encodeURIComponent(JSON.stringify(payload))}`;
      const response = await fetch(url, {method: "GET"});

      if (!response.ok) throw new Error(`Failed to ${enabled ? "enable" : "disable"} PEQ: ${response.status}`);

      const data = await response.json();
      if (data.status !== "OK") throw new Error(`PEQ ${enabled ? "enable" : "disable"} failed: ${JSON.stringify(data)}`);

      console.log(`WiiM PEQ ${enabled ? "enabled" : "disabled"} successfully`);

    } catch (error) {
      console.error("Error toggling WiiM PEQ:", error);
      throw error;
    }
  }

  /**
   * Parse WiiM PEQ JSON response into a standardized format
   * @param {Object} data - The WiiM PEQ data
   * @returns {Array} Formatted PEQ filter list
   */
  function parseWiiMEQData(data) {
    const eqBands = data.EQBand || [];
    const filters = [];

    for (let i = 0; i < eqBands.length; i += 4) {
      const filterType = convertFromWiimMode(eqBands[i].value);
      const frequency = eqBands[i + 1].value;
      const qFactor = eqBands[i + 2].value;
      const gain = eqBands[i + 3].value;

      filters.push({
        type: filterType,
        freq: frequency,
        q: qFactor,
        gain: gain,
        disabled: filterType === "Off",
      });
    }

    return filters;
  }

  /**
   * Convert internal filter type to WiiM filter mode
   * @param {string} type - Internal filter type (PK, LSQ, HSQ)
   * @returns {number} WiiM PEQ mode value
   */
  function convertToWiimMode(type) {
    const mapping = {"Off": -1, "Low-Shelf": 0, "Peak": 1, "High-Shelf": 2};
    return mapping[type] !== undefined ? mapping[type] : 1;
  }

  /**
   * Convert WiiM filter mode to internal filter type
   * @param {number} mode - WiiM PEQ mode value
   * @returns {string} Internal filter type
   */
  function convertFromWiimMode(mode) {
    switch (mode) {
      case 0:
        return "Low-Shelf";
      case 1:
        return "Peak";
      case 2:
        return "High-Shelf";
      default:
        return "Off";
    }
  }

  async function getCurrentSlot(ip) {
    return 0;
  }

  async function getAvailableSlots(ip) {
    const url = `https://${ip}/httpapi.asp?command=EQv2GetList:${encodeURIComponent(PLUGIN_URI)}`;
    try {
      const response = await fetch(url, {method: "GET", mode: "no-cors" });
      if (!response.status == 0) {
        throw new Error(`Failed to fetch preset list: ${response.status}`);
      }

      return [ {id: 0, name: "Cannot read"}];

    } catch (error) {
      console.error("Error retrieving preset list from WiiM:", error);
      throw error;
    }
  }

  return {
    getCurrentSlot,
    getAvailableSlots,
    pullFromDevice,
    pushToDevice,
    enablePEQ,
  };
})();
  return wiimNetworkHandler;
})();

// ==== usbDeviceConfig.js ====
const usbHidDeviceHandlerConfig = (() => {
// Dynamically import manufacturer specific handlers for their unique devices
// Main list of HID devices - each vendor has one or more vendorId, and a list of devices associated,
// each device has a model of how the slots are configured and a handler to handle reading / writing
// the raw USBHID reports to the device
const usbHidDeviceHandlerConfig = ([
  {
    vendorIds: [0x2972,0x0A12],
    manufacturer: "FiiO",
    handler: fiioUsbHID,
    defaultModelConfig: { // Fallback if we haven't got specific details yet
      minGain: -12,
      maxGain: 12,
      maxFilters: 5,
      firstWritableEQSlot: -1,
      maxWritableEQSlots: 0,
      disconnectOnSave: true,
      disabledPresetId: -1,
      experimental: false,
      supportsLSHSFilters: true,
      supportsPregain: true,
      defaultResetFiltersValues:[{gain:0, freq: 100, q:1, filterType: "PK"}],
      reportId: 7,
      availableSlots: [
        {id: 0, name: "Jazz"},
        {id: 1, name: "Pop"},
        {id: 2, name: "Rock"},
        {id: 3, name: "Dance"},
        {id: 4, name: "R&B"},
        {id: 5, name: "Classic"},
        {id: 6, name: "Hip-hop"},
        {id: 7, name: "Monitor"},
        {id: 160, name: "USER1"},
        {id: 161, name: "USER2"},
        {id: 162, name: "USER3"},
        {id: 163, name: "USER4"},
        {id: 164, name: "USER5"},
        {id: 165, name: "USER6"},
        {id: 166, name: "USER7"},
        {id: 167, name: "USER8"},
        {id: 168, name: "USER9"},
        {id: 169, name: "USER10"}
      ]
    },
    devices: {
      "FIIO QX13": {
        modelConfig: {
          maxFilters: 10,
          disconnectOnSave: false
        }
      },
      "SNOWSKY Melody": {
        manufacturer: "FiiO",
        handler: fiioUsbHID,
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: -1,
          disabledPresetId: 240,
          maxWritableEQSlots: 0,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 160, name: "USER1"}, {id: 161, name: "USER2"}, {
            id: 162,
            name: "USER3"
          }]

        }
      },
      "JadeAudio JIEZI": {
        manufacturer: "FiiO",
        handler: fiioUsbHID,
          modelConfig: {
            minGain: -12,
            maxGain: 12,
            maxFilters: 5,
            firstWritableEQSlot: 3,
            maxWritableEQSlots: 1,
            disconnectOnSave: true,
            disabledPresetId: 4,
            reportId: 2,
          }
        },
      "JadeAudio JA11": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 5,
          firstWritableEQSlot: 3,
          maxWritableEQSlots: 1,
          disconnectOnSave: true,
          disabledPresetId: 4,
          reportId: 2,
          availableSlots: [{id: 0, name: "Vocal"}, {id: 1, name: "Classic"}, {id: 2, name: "Bass"}, {
            id: 3,
            name: "USER1"
          }]
        }
      },
      "FIIO KA17": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          reportId: 1,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 4, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "FIIO Q7": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          reportId: 1,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 4, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "FIIO KA17 (MQA HID)": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          reportId: 1,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 4, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "FIIO BT11 (UAC1.0)": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          reportId: 1,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 4, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "FIIO Air Link": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          reportId: 1,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 5,
            name: "R&B"
          }, {id: 6, name: "Classic"}, {id: 7, name: "Hip-hop"}, {id: 4, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "FIIO BTR13": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 12,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 4,
            name: "R&B"
          }, {id: 5, name: "Classic"}, {id: 6, name: "Hip-hop"}, {id: 7, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "BTR17": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
        }
      },
      "FIIO KA15": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          availableSlots: [{id: 0, name: "Jazz"}, {id: 1, name: "Pop"}, {id: 2, name: "Rock"}, {
            id: 3,
            name: "Dance"
          }, {
            id: 4,
            name: "R&B"
          }, {id: 5, name: "Classic"}, {id: 6, name: "Hip-hop"}, {id: 7, name: "USER1"}, {id: 8, name: "USER2"}, {
            id: 9,
            name: "USER3"
          }]
        }
      },
      "LS-TC2": {
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 5,
          firstWritableEQSlot: 3,
          maxWritableEQSlots: 1,
          disconnectOnSave: true,
          disabledPresetId: 11,
          experimental: true,
          availableSlots: [{id: 0, name: "Vocal"}, {id: 1, name: "Classic"}, {id: 2, name: "Bass"}, {
            id: 3,
            name: "Dance"
          }, {id: 4, name: "R&B"}, {id: 5, name: "Classic"}, {id: 6, name: "Hip-hop"}, {id: 160, name: "USER1"}]
        }
      }
    }
  },
  {
    vendorIds: [0x3302, 0x0762, 0x35D8, 0x2FC6, 0x0104, 0xB445, 0x0661, 0x0666, 0x0D8C], // multiple Walkplay vendorIds
    manufacturer: "WalkPlay",
    handler: walkplayUsbHID,
    defaultModelConfig: {
      minGain: -12,
      maxGain: 6,
      maxFilters: 8,
      schemeNo: 10,
      firstWritableEQSlot: -1,
      maxWritableEQSlots: 0,
      disconnectOnSave: false,
      disabledPresetId: -1,
      supportsPregain: true,
      defaultResetFiltersValues:[{gain:0, freq: 100, q:1, filterType: "PK"}],
      supportsLSHSFilters: false,
      autoGlobalGain: false,
      experimental: false,
      availableSlots: [{id: 101, name: "Custom"}]
    },
    devices: {
      "FIIO FX17 ": {
        manufacturer: "FiiO",
        handler: fiioUsbHID,
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 7,
          maxWritableEQSlots: 3,
          disconnectOnSave: false,
          disabledPresetId: 11,
          experimental: false,
          availableSlots: [
            {id: 0, name: "Jazz"},
            {id: 1, name: "Pop"},
            {id: 2, name: "Rock"},
            {id: 3, name: "Dance"},
            {id: 4, name: "R&B"},
            {id: 5, name: "Classic"},
            {id: 6, name: "Hip-hop"},
            {id: 7, name: "Monitor"},
            {id: 160, name: "USER1"},
            {id: 161, name: "USER2"},
            {id: 162, name: "USER3"},
            {id: 163, name: "USER4"},
            {id: 164, name: "USER5"},
            {id: 165, name: "USER6"},
            {id: 166, name: "USER7"},
            {id: 167, name: "USER8"},
            {id: 168, name: "USER9"},
            {id: 169, name: "USER10"}
          ]
        }
      },
      "Rays": {
        manufacturer: "Moondrop",
        handler: moondropUsbHidHandler,
        modelConfig: {
          supportsLSHSFilters: true,
          supportsPregain: true,
        }
      },
      "EPZ TP13 AI ENC audio": {
        manufacturer: "EPZ",
        modelConfig: {
          supportsLSHSFilters: false,
          supportsPregain: true,
        }
      },
      "Marigold": {
        manufacturer: "Moondrop",
        handler: moondropUsbHidHandler,
        modelConfig: {
          supportsLSHSFilters: false,
          supportsPregain: true,
        }
      },
      "FreeDSP Pro": {
        manufacturer: "Moondrop",
        handler: moondropUsbHidHandler,
        modelConfig: {
          supportsLSHSFilters: true,
          supportsPregain: true,
        }
      },
      "ddHiFi DSP IEM - Memory": {
        manufacturer: "Moondrop",
        handler: moondropUsbHidHandler
      },
      "Quark2": {
        manufacturer: "Moondrop"
      },
      "ECHO-A": {
        manufacturer: "Moondrop"
      },
      "Truthear KEYX": {
        manufacturer: "Truthear",
        handler: walkplayUsbHID,
        modelConfig: {
          minGain: -12,
          maxGain: 6,
          maxFilters: 8,
          firstWritableEQSlot: -1,
          maxWritableEQSlots: 0,
          disconnectOnSave: false,
          disabledPresetId: -1,
          supportsPregain: true,
          supportsLSHSFilters: false,
          experimental: false,
          defaultIndex: 0x17,
          availableSlots: [{id: 101, name: "Custom"}]
        }
      },
      "Hi-MAX": {
        modelConfig: {
          experimental: false
        }
      },
      "BGVP MX1": {
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "DT04": {
        manufacturer: "LETSHUOER",
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "MD-QT-042": {
        manufacturer: "Moondrop",
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "MOONDROP HiFi with PD": {
        manufacturer: "Moondrop",
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "DAWN PRO 2": {
        manufacturer: "Moondrop",
        modelConfig: {
          schemeNo: 15,
          experimental: false
        }
      },
      "CS431XX": {
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "ES9039 ": {
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "TANCHJIM-STARGATE II": {
        manufacturer: "Tanchim",
        modelConfig: {
          schemeNo: 15,
          supportsLSHSFilters: false
        }
      },
      "didiHiFi DSP Cable - Memory": {
        manufacturer: "ddHifi",
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "Dual CS43198": {
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "ES9039 HiFi DSP Audio": {
        modelConfig: {
          schemeNo: 15,
          experimental: true
        }
      },
      "Protocol Max": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          minGain: -10,
          maxGain: 10,
          autoGlobalGain: true,
          supportsLSHSFilters: true,
          supportsPregain: true
        }
      },
      "AE6": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          experimental: true
        }
      },
      "KM_HA03": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          experimental: true
        }
      },
      "TP35 Pro": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10
        }
      },
      "DA5": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          experimental: true
        }
      },
      "G303": {
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          experimental: true
        }
      },
      "HiFi DSP Audio with PD": {
        manufacturer: "ddHifi",
        modelConfig: {
          schemeNo: 16,
          maxFilters: 10,
          experimental: true
        }
      },
    }
  },
  {
    vendorIds: [0x31B2],
    manufacturer: "KT Micro",
    handler: ktmicroUsbHidHandler,
    defaultModelConfig: {
      minGain: -12,
      maxGain: 12,
      maxFilters: 5,
      firstWritableEQSlot: -1,
      maxWritableEQSlots: 0,
      compensate2X: true,  // Lets compenstate by default
      disconnectOnSave: true,
      disabledPresetId: 0x02,
      experimental: false,
      supportsPregain: false,
      supportsLSHSFilters: true,
      defaultResetFiltersValues:[{gain:0, freq: 100, q:1, filterType: "PK"}],
      availableSlots: [{id: 0x03, name: "Custom"}]
    },
    devices: {
      "Kiwi Ears-Allegro PRO": {
        manufacturer: "Kiwi Ears",
        modelConfig: {
          supportsLSHSFilters: false,
          disconnectOnSave: true,
        }
      },
      "KT02H20 HIFI Audio": {
        manufacturer: "JCally",
        modelConfig: {
          supportsLSHSFilters: false,
        }
      },
      "TANCHJIM BUNNY DSP": {
        manufacturer: "TANCHJIM",
        modelConfig: {
          compensate2X: false,
          supportsPregain: true,
        }
      },
      "TANCHJIM FISSION": {
        manufacturer: "TANCHJIM",
        modelConfig: {
          compensate2X: false,
          supportsPregain: true,
        }
      },
      "CDSP": {
        manufacturer: "Moondrop",
        modelConfig: {
          compensate2X: false
        }
      },
      "Chu2 DSP": {
        manufacturer: "Moondrop",
        modelConfig: {
          compensate2X: false
        }
      }
    }
  },
  {
    vendorIds: [0x152A], // 5418 in decimal = 0x152A in hex
    manufacturer: "Topping",
    handler: toppingUsbHidHandler,
    defaultModelConfig: {
      minGain: -12,
      maxGain: 12,
      maxFilters: 10,
      firstWritableEQSlot: 0,
      maxWritableEQSlots: 3,
      disconnectOnSave: false,
      disabledPresetId: -1,
      experimental: true,
      supportsPregain: true,
      supportsLSHSFilters: true,
      defaultResetFiltersValues:[{gain:0, freq: 100, q:1, filterType: "PK"}],
      availableSlots: [
        {id: 0, name: "Custom 1"},
        {id: 1, name: "Custom 2"},
        {id: 2, name: "Custom 3"}
      ]
    },
    devices: {
      "DX5 II": {
        productId: 0x8740, // 34640 in decimal = 0x8740 in hex
        modelConfig: {
          maxFilters: 10,
          experimental: true
        }
      }
    }
  }
])
  return usbHidDeviceHandlerConfig;
})();

// ==== usbSerialDeviceConfig.js ====
const usbSerialDeviceHandlerConfig = (() => {
// Dynamically import the USB Serial handlers
const usbSerialDeviceHandlerConfig = [
  {
    vendorId: 0x152a, // JDS Labs USB Vendor ID (common for JDS Labs / Teensy based boards)
    manufacturer: "JDS Labs",
    handler: jdsLabsUsbSerial,
    devices: {
      "Element IV": {
        usbProductId: 35066,
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 10,
          firstWritableEQSlot: 0,
          maxWritableEQSlots: 1,
          disconnectOnSave: false,
          disabledPresetId: -1,
          experimental: false,
          availableSlots: [{ id: 0, name: "Headphones" },{ id: 1, name: "RCA" }]
        }
      }
    }
  },
  {
    // Nothing headphones support both USB Serial and Bluetooth SPP
    manufacturer: "Nothing",
    handler: nothingUsbSerial,
    // Enhanced filtering - support both USB vendor ID and Bluetooth SPP UUID
    filters: {
      // USB Serial filtering (if connected via USB)
      usbVendorId: null, // Nothing doesn't have a specific USB vendor ID for headphones
      // Bluetooth SPP filtering (primary connection method)
      allowedBluetoothServiceClassIds: ["aeac4a03-dff5-498f-843a-34487cf133eb"],
      bluetoothServiceClassId: "aeac4a03-dff5-498f-843a-34487cf133eb"
    },
    devices: {
      "Nothing Headphones": {
        // No specific USB product ID since these are primarily Bluetooth devices
        modelConfig: {
          minGain: -12,
          maxGain: 12,
          maxFilters: 8, // Based on the EQ values parsing in the HTML
          firstWritableEQSlot: 5,
          maxWritableEQSlots: 1, // Only the Custom profile is writable
          disconnectOnSave: false,
          disabledPresetId: -1,
          experimental: false,
          readOnly: false, // Enable writing for Custom profile
          availableSlots: [
            { id: 0, name: "Balanced" },
            { id: 1, name: "Voice" },
            { id: 2, name: "More Treble" },
            { id: 3, name: "More Bass" },
            { id: 5, name: "Custom" }
          ]
        }
      }
    }
  },
  {
    vendorId: 6790, // FiiO USB Vendor ID
    manufacturer: "FiiO",
    handler: fiioUsbSerial,
    devices: {
      "FiiO Audio DSP": {
        usbProductId: 21971,
        modelConfig: {
          // Serial configuration
          baudRate: 57600,

          // Model capabilities
          minGain: -12,
          maxGain: 12,
          maxFilters: 10, // Typical FiiO EQ band count
          firstWritableEQSlot: 0,
          maxWritableEQSlots: 21, // Support for all FiiO presets
          disconnectOnSave: false,
          disabledPresetId: 11, // Based on FiiO code showing preset 11 for disabled EQ
          experimental: false,
          availableSlots: [
            { id: 240, name: "BYPASS" },
            { id: 0, name: "Jazz" },
            { id: 1, name: "Pop" },
            { id: 2, name: "Rock" },
            { id: 3, name: "Dance" },
            { id: 4, name: "R&B" },
            { id: 5, name: "Classic" },
            { id: 6, name: "Hip Hop" },
            { id: 8, name: "Retro" },
            { id: 9, name: "De-essing-1" },
            { id: 10, name: "De-essing-2" },
            { id: 160, name: "USER1" },
            { id: 161, name: "USER2" },
            { id: 162, name: "USER3" },
            { id: 163, name: "USER4" },
            { id: 164, name: "USER5" },
            { id: 165, name: "USER6" },
            { id: 166, name: "USER7" },
            { id: 167, name: "USER8" },
            { id: 168, name: "USER9" },
            { id: 169, name: "USER10" }
          ]
        }
      }
    }
  }
];
  return usbSerialDeviceHandlerConfig;
})();

// ==== usbHidConnector.js ====
const UsbHIDConnector = (() => {
//
// Copyright 2024 : Pragmatic Audio
//
// Declare UsbHIDConnector and attach it to the global window object

const UsbHIDConnector = ( async function () {
    let currentDevice = null;
const getDeviceConnected = async () => {
        try {
            const vendorToManufacturer = usbHidDeviceHandlerConfig.flatMap(entry =>
              entry.vendorIds.map(vendorId => ({
                vendorId,
                name: entry.name
              }))
            );
            // Request devices matching the filters
            const selectedDevices = await navigator.hid.requestDevice({ filters: vendorToManufacturer });

            if (!selectedDevices || selectedDevices.length === 0) {
                throw new Error("未选择任何 USB HID 设备。");
            }

            if (selectedDevices.length > 0) {
                const rawDevice = selectedDevices[0];
                // Find the vendor configuration matching the selected device
              const vendorConfig = usbHidDeviceHandlerConfig.find(entry =>
                entry.vendorIds.includes(rawDevice.vendorId)
              );

                if (!vendorConfig) {
                  const deviceLabel = rawDevice.productName || `VID 0x${rawDevice.vendorId.toString(16)}`;
                  throw new Error(`暂不支持该 USB HID 设备：${deviceLabel}`);
                }

                const model = rawDevice.productName;

                // Look up the model-specific configuration from the vendor config.
                // If no specific model configuration exists, fall back to a default if provided.
                let deviceDetails = vendorConfig.devices[model] || {};
                let modelConfig = Object.assign(
                  {},
                  vendorConfig.defaultModelConfig || {},
                  deviceDetails.modelConfig || {}
                );

                const manufacturer = deviceDetails.manufacturer | vendorConfig.manufacturer;
                let handler = deviceDetails.handler ||  vendorConfig.handler;

                // Check if already connected
                if (currentDevice != null) {
                  return currentDevice;
                }

                // Open the device if not already open
                if (!rawDevice.opened) {
                    await rawDevice.open();
                }
                currentDevice = {
                    rawDevice: rawDevice,
                    manufacturer: manufacturer,
                    model: model,
                    handler: handler,
                    modelConfig: modelConfig
                };

                return currentDevice;
            } else {
                throw new Error("未找到可连接的 USB HID 设备。");
            }
        } catch (error) {
            console.error("Failed to connect to HID device:", error);
            if (error && error.name === "NotFoundError") {
                throw new Error("已取消 USB HID 设备选择。");
            }
            if (error && error.name === "SecurityError") {
                throw new Error("浏览器拒绝访问 USB HID 设备。请检查权限或改用最新版 Chrome / Edge。");
            }
            throw error;
        }
    };

    const disconnectDevice = async () => {
        if (currentDevice && currentDevice.rawDevice) {
            try {
                await currentDevice.rawDevice.close();
                console.log("Device disconnected:", currentDevice.model);
                currentDevice = null;
            } catch (error) {
                console.error("Failed to disconnect device:", error);
            }
        }
    };
    const checkDeviceConnected = async (device) => {
        var rawDevice = device.rawDevice;
        const rawDevices = await navigator.hid.getDevices();
        var matchingRawDevice =  rawDevices.find(d => d.vendorId === rawDevice.vendorId && d.productId == rawDevice.productId);
        if (typeof matchingRawDevice == 'undefined' || matchingRawDevice == null ) {
            console.error("Device disconnected?");
            alert('Device disconnected?');
            return false;
        }
        // But lets check if we are still open otherwise we need to open the device again
        if (!matchingRawDevice.opened) {
          await matchingRawDevice.open();
          device.rawDevice = matchingRawDevice; // Swap the device over
        }
        return true;
    };

    const pushToDevice = async (device, slot, preamp, filters) => {
        if (!await checkDeviceConnected(device)) {
            throw Error("Device Disconnected");
        }
        if (device && device.handler) {

          // Create a copy of the filters array to avoid modifying the original
          const filtersToWrite = [...filters];

          // Ensure array is at most the maxFilters
          if (filtersToWrite.length > device.modelConfig.maxFilters) {
            console.warn(`USB Device PEQ: Truncating ${filtersToWrite.length} filters to ${device.modelConfig.maxFilters} (device limit)`);
            if (window.showToast) {
              await window.showToast(`This device only supports ${device.modelConfig.maxFilters} PEQ filters - only first ${device.modelConfig.maxFilters} will be applied.`, "warning", 10000, true);
            }

            filtersToWrite.splice(device.modelConfig.maxFilters);
          }

          // And do an upfront sanity check on the values
          for (let i = 0 ; i < filtersToWrite.length; i++) {
            // A quick sanity check on the filters
            if (filtersToWrite[i].freq < 20 || filtersToWrite[i].freq > 20000) {
              filtersToWrite[i].freq = 100;
            }
            if (filtersToWrite[i].q < 0.01 || filtersToWrite[i].q > 100) {
              filtersToWrite[i].q = 1;
            }
          }

          // Next, determine if we have LS/HS filters with non-zero gain
          const hasLSHSFilters = filtersToWrite.some(filter =>
            (filter.type === "LSQ" || filter.type === "HSQ") && filter.gain !== 0);

          // Second, determine if we need pregain (only if globalGain is positive)
          const needsPreGain = preamp < 0;

          // Handle LS/HS filters if device doesn't support them
          if (hasLSHSFilters && device.modelConfig.supportsLSHSFilters === false) {
            // Convert LS/HS filters with non-zero gain to PK with gain=0
            for (let i = 0; i < filtersToWrite.length; i++) {
              if ((filtersToWrite[i].type === "LSQ" || filtersToWrite[i].type === "HSQ") && filtersToWrite[i].gain !== 0) {
                console.log(`USB Device PEQ: converting ${filtersToWrite[i].type} filter to PK with gain=0`);
                filtersToWrite[i].type = "PK";
                filtersToWrite[i].gain = 0;
              }
            }
          }

          // Handle warnings based on device capabilities and filter requirements
          if (hasLSHSFilters && device.modelConfig.supportsLSHSFilters === false &&
            needsPreGain && device.modelConfig.supportsPregain === false) {
            // Case 1: Device doesn't support both LSHS filters and pregain
            console.warn("Device doesn't support LS/HS filters and auto pregain - both will be ignored");
            if (window.showToast) {
              window.showToast("Device doesn't support LS/HS filters and auto pregain - both will be ignored", "warning");
            }
          } else if (hasLSHSFilters && device.modelConfig.supportsLSHSFilters === false) {
            // Case 2: Device only doesn't support LSHS filters
            console.warn("Device only supports Peak filters - ignoring LS/HS filters");
            if (window.showToast) {
              window.showToast("Device only supports Peak filters - ignoring LS/HS filters", "warning");
            }
          } else if (needsPreGain && device.modelConfig.supportsPregain === false) {
            // Case 3: Device only doesn't support pregain
            console.warn("Device does not support auto calculated pregain");
            if (window.showToast) {
              window.showToast("Device does not support auto calculated pregain", "warning");
            }
          }

          // If we have fewer filters than maxFilters, fill the rest with defaultResetFiltersValues
          if (filtersToWrite.length < device.modelConfig.maxFilters && device.modelConfig.defaultResetFiltersValues) {
            const defaultFilter = device.modelConfig.defaultResetFiltersValues[0];
            console.log(`USB Device PEQ: filling missing filters with defaults:`, defaultFilter);

            for (let i = filtersToWrite.length; i < device.modelConfig.maxFilters; i++) {

              filtersToWrite.push({...defaultFilter});
            }
          }

          return await device.handler.pushToDevice(device, slot, preamp, filtersToWrite);
      } else {
          console.error("No device handler available for pushing.");
      }
      return true;   // Disconnect anyway
    };

    // Helper Function to Get Available 'Custom' Slots Based on the Device that we can write too
    const  getAvailableSlots = async (device) => {
        return device.modelConfig.availableSlots;
    };

    const getCurrentSlot = async (device) => {
        if (device && device.handler) {
            return await device.handler.getCurrentSlot(device)
        }{
            console.error("No device handler available for querying");
            return -2;
        }
    };

    const pullFromDevice = async (device, slot) => {
        if (!await checkDeviceConnected(device)) {
            throw Error("Device Disconnected");
        }
        if (device && device.handler) {
            return await device.handler.pullFromDevice(device, slot);
        } else {
            console.error("No device handler available for pulling.");
            return { filters: [] }; // Empty filters
        }
    };

    const enablePEQ = async (device, enabled, slotId) => {
        if (device && device.handler) {
            return await device.handler.enablePEQ(device, enabled, slotId);
        } else {
            console.error("No device handler available for enabling.");
        }
    };

    const getCurrentDevice = () => currentDevice;

    return {
        getDeviceConnected,
        getAvailableSlots,
        disconnectDevice,
        pushToDevice,
        pullFromDevice,
        getCurrentDevice,
        getCurrentSlot,
        enablePEQ,
    };
})();
  return UsbHIDConnector;
})();

// ==== usbSerialConnector.js ====
const UsbSerialConnector = (() => {
// Copyright 2024 : Pragmatic Audio
// Declare UsbSerialConnector and attach it to the global window object

const UsbSerialConnector = (async function () {
  let devices = [];
  let currentDevice = null;
const getDeviceConnected = async () => {
    try {
      // Build filters for device selection - support both USB and Bluetooth SPP
      const filters = [];

      // Add USB vendor ID filters for traditional USB devices
      for (const entry of usbSerialDeviceHandlerConfig) {
        if (entry.vendorId) {
          filters.push({ usbVendorId: entry.vendorId });
        }
        // Add Bluetooth SPP filters for enhanced filtering
        if (entry.filters && entry.filters.allowedBluetoothServiceClassIds) {
          for (const serviceId of entry.filters.allowedBluetoothServiceClassIds) {
            filters.push({ bluetoothServiceClassId: serviceId });
          }
        }
      }

      const requestOptions = {};
      if (filters.length > 0) {
        requestOptions.filters = filters;
      }

      // Also add allowedBluetoothServiceClassIds for Nothing devices
      const bluetoothServiceIds = [];
      for (const entry of usbSerialDeviceHandlerConfig) {
        if (entry.filters && entry.filters.allowedBluetoothServiceClassIds) {
          bluetoothServiceIds.push(...entry.filters.allowedBluetoothServiceClassIds);
        }
      }
      if (bluetoothServiceIds.length > 0) {
        requestOptions.allowedBluetoothServiceClassIds = bluetoothServiceIds;
      }

      const rawDevice = await navigator.serial.requestPort(requestOptions);
      const info = rawDevice.getInfo();
      const productId = info.usbProductId;
      const bluetoothServiceClassId = info.bluetoothServiceClassId;

      let vendorConfig = null;
      let modelName = null;
      var modelConfig = {};
      var handler = null;

      // Enhanced device matching - support both USB and Bluetooth SPP
      for (const entry of usbSerialDeviceHandlerConfig) {
        let deviceMatched = false;

        // Check USB vendor ID match (traditional method)
        if (entry.vendorId && entry.vendorId === info.usbVendorId) {
          for (const [name, model] of Object.entries(entry.devices)) {
            if (model.usbProductId === productId) {
              vendorConfig = entry;
              modelName = name;
              modelConfig = model.modelConfig || {};
              handler = entry.handler;
              deviceMatched = true;
              break;
            }
          }
        }

        // Check Bluetooth SPP UUID match (enhanced filtering)
        if (!deviceMatched && entry.filters) {
          const svc = (bluetoothServiceClassId || '').toLowerCase();
          const cfgSingle = (entry.filters.bluetoothServiceClassId || '').toLowerCase();
          const cfgList = Array.isArray(entry.filters.allowedBluetoothServiceClassIds)
            ? entry.filters.allowedBluetoothServiceClassIds.map(x => String(x).toLowerCase())
            : [];
          const matchesSingle = svc && cfgSingle && svc === cfgSingle;
          const matchesAny = svc && cfgList.includes(svc);
          if (matchesSingle || matchesAny) {
            // For Bluetooth devices, use the first (and typically only) device entry
            const deviceEntries = Object.entries(entry.devices);
            if (deviceEntries.length > 0) {
              const [name, model] = deviceEntries[0];
              vendorConfig = entry;
              modelName = name;
              modelConfig = model.modelConfig || {};
              handler = entry.handler;
              deviceMatched = true;
            }
          }
        }

        if (deviceMatched) break;
      }

      if (!vendorConfig) {
        const deviceId = productId ? `0x${productId.toString(16)}` : bluetoothServiceClassId || 'Unknown';
        const statusEl = document.getElementById('status');
        if (statusEl) {
          statusEl.innerText = `不支持的 Serial / Bluetooth 设备 (${deviceId})`;
        }
        throw new Error(`暂不支持该 Serial / Bluetooth 设备：${deviceId}`);
      }

      // Open device with appropriate baud rate
      // - Bluetooth SPP typically uses 9600
      // - Otherwise default to 115200 unless overridden by modelConfig.baudRate
      const defaultBaud = bluetoothServiceClassId ? 9600 : 115200;
      const baudRate = (modelConfig && modelConfig.baudRate && !bluetoothServiceClassId)
        ? modelConfig.baudRate
        : defaultBaud;
      await rawDevice.open({ baudRate });

      // Set up readable and writable shim helpers for handlers expecting simple read()/write()
      // Important: do NOT hold reader/writer locks persistently to avoid blocking other handlers (e.g., FiiO)
      let readable = null;
      let writable = null;
      try {
        if (rawDevice.readable && typeof rawDevice.readable.getReader === 'function') {
          readable = {
            async read() {
              const r = rawDevice.readable.getReader();
              try {
                const res = await r.read();
                return res;
              } finally {
                try { r.releaseLock(); } catch (_) {}
              }
            }
          };
        }
        if (rawDevice.writable && typeof rawDevice.writable.getWriter === 'function') {
          writable = {
            async write(data) {
              const w = rawDevice.writable.getWriter();
              try {
                await w.write(data);
              } finally {
                try { w.releaseLock(); } catch (_) {}
              }
            }
          };
        }
      } catch (e) {
        console.warn('UsbSerialConnector: Failed to set up read/write shims:', e);
      }

      const model = vendorConfig.model || modelName || "Unknown Serial Device";

      currentDevice = {
        rawDevice: rawDevice,
        info,
        manufacturer: vendorConfig.manufacturer,
        model,
        handler,
        modelConfig,
        // Backward-compatibility for handlers (e.g., Nothing) that call device.readable.read() / device.writable.write()
        readable,
        writable
      };

      devices.push(currentDevice);
      return currentDevice;
    } catch (error) {
      console.error("Failed to connect to Serial device:", error);
      if (error && error.name === "NotFoundError") {
        throw new Error("已取消 Serial / Bluetooth 设备选择。");
      }
      if (error && error.name === "SecurityError") {
        throw new Error("浏览器拒绝访问 Serial / Bluetooth 设备。请检查权限或改用最新版 Chrome / Edge。");
      }
      throw error;
    }
  };

  const disconnectDevice = async () => {
    if (currentDevice && currentDevice.rawDevice) {
      try {
        // Release reader/writer if we created them
        try {
          if (currentDevice.readable && typeof currentDevice.readable.releaseLock === 'function') {
            currentDevice.readable.releaseLock();
          }
        } catch (e) {
          console.warn('UsbSerialConnector: releasing readable lock failed', e);
        }
        try {
          if (currentDevice.writable && typeof currentDevice.writable.releaseLock === 'function') {
            currentDevice.writable.releaseLock();
          }
        } catch (e) {
          console.warn('UsbSerialConnector: releasing writable lock failed', e);
        }

        await currentDevice.rawDevice.close();
        devices = devices.filter(d => d !== currentDevice);
        currentDevice = null;
        console.log("Serial device disconnected.");
      } catch (error) {
        console.error("Failed to disconnect serial device:", error);
      }
    }
  };

  const pushToDevice = async (device, slot, preamp, filters) => {
    if (!device || !device.handler) return;
    return await device.handler.pushToDevice(device, slot, preamp, filters);
  };

  const pullFromDevice = async (device, slot) => {
    if (!device || !device.handler) return { filters: [] };
    return await device.handler.pullFromDevice(device, slot);
  };

  const getAvailableSlots = async (device) => {
    return device.modelConfig.availableSlots;
  };

  const getCurrentSlot = async (device) => {
    if (device && device.handler) return await device.handler.getCurrentSlot(device);
    return -2;
  };

  const enablePEQ = async (device, enabled, slotId) => {
    if (device && device.handler) return await device.handler.enablePEQ(device, enabled, slotId);
  };

  const getCurrentDevice = () => currentDevice;

  return {
    getDeviceConnected,
    getAvailableSlots,
    disconnectDevice,
    pushToDevice,
    pullFromDevice,
    getCurrentDevice,
    getCurrentSlot,
    enablePEQ,
  };
})();
  return UsbSerialConnector;
})();

// ==== networkDeviceConnector.js ====
const NetworkDeviceConnector = (() => {
// networkDeviceConnector.js
// Copyright 2024 : Pragmatic Audio
const NetworkDeviceConnector = (function () {
    let currentDevice = null;
    const deviceHandlers = {
        "WiiM": wiimNetworkHandler, // Will be dynamically imported
    };
    async function getDeviceConnected(deviceIP, deviceType) {
        try {
            if (!deviceIP) {
                throw new Error("未填写设备 IP 地址。");
            }

            if (!deviceHandlers[deviceType]) {
                throw new Error(`暂不支持该网络设备类型：${deviceType}`);
            }

            currentDevice = {
                ip: deviceIP,
                type: deviceType,
                handler: deviceHandlers[deviceType]
            };

            console.log(`Connected to ${deviceType} at ${deviceIP}`);
            return currentDevice;
        } catch (error) {
            console.error("Failed to connect to Network Device:", error);
            throw error;
        }
    }

    async function disconnectDevice() {
        if (currentDevice) {
            console.log(`Disconnected from ${currentDevice.type} at ${currentDevice.ip}`);
            currentDevice = null;
        }
    }

    async function pushToDevice(device, slot, preamp, filters) {
        if (!currentDevice) {
            console.warn("No network device connected.");
            return;
        }
        return await currentDevice.handler.pushToDevice(currentDevice.ip, slot, preamp, filters);
    }

    async function pullFromDevice(device, slot) {
        if (!currentDevice) {
            console.warn("No network device connected.");
            return;
        }
        return await currentDevice.handler.pullFromDevice(currentDevice.ip, slot);
    }
    async function getCurrentSlot(device) {
      if (!deviceHandlers[device.type]) {
        console.warn("Unsupported Device Type.");
        return null;
      }
      return await deviceHandlers[device.type].getCurrentSlot(device.IP);
    }
  async function getAvailableSlots(device) {
    if (!deviceHandlers[device.type]) {
      console.warn("Unsupported Device Type.");
      return null;
    }
    return await deviceHandlers[device.type].getAvailableSlots(device.ip);
  }

    async function enablePEQ(device, enabled, slotId) {
        if (!currentDevice) {
            console.warn("No network device connected.");
            return;
        }
        return await currentDevice.handler.enablePEQ(currentDevice.ip, enabled, slotId);
    }

    return {
        getAvailableSlots,
        getCurrentSlot,
        getDeviceConnected,
        disconnectDevice,
        pushToDevice,
        pullFromDevice,
        enablePEQ,
    };
})();
  return NetworkDeviceConnector;
})();

// ==== plugin.js ====
const initializeDeviceEqPlugin = (() => {
// Copyright 2024 : Pragmatic Audio

/**
 * Initialise the plugin - passing the content from the extraEQ section so we can both query
 * and update that area and add our UI elements.
 *
 * @param context
 * @returns {Promise<void>}
 */
async function initializeDeviceEqPlugin(context) {
  // Initialize console log history array if it doesn't exist
  if (!window.consoleLogHistory) {
    window.consoleLogHistory = [];

    // Store original console methods
    const originalConsoleLog = console.log;
    const originalConsoleError = console.error;
    const originalConsoleWarn = console.warn;

    // Flag to control logging visibility
    window.showDeviceLogs = false;

    // Override console.log to capture logs
    // console.log = function() {
    //   // Convert arguments to string and add to history
    //   const logString = Array.from(arguments).map(arg =>
    //     typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
    //   ).join(' ');
    //   window.consoleLogHistory.push(`[LOG] ${logString}`);

    //   // Call original method only if showLogs is true or we have an experimental device
    //   if (window.showDeviceLogs) {
    //     originalConsoleLog.apply(console, arguments);
    //   }
    // };

    // Override console.error to capture errors
    console.error = function() {
      // Convert arguments to string and add to history
      const logString = Array.from(arguments).map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      window.consoleLogHistory.push(`[ERROR] ${logString}`);

      // Always show errors regardless of log settings
      originalConsoleError.apply(console, arguments);
    };

    // Override console.warn to capture warnings
    console.warn = function() {
      // Convert arguments to string and add to history
      const logString = Array.from(arguments).map(arg =>
        typeof arg === 'object' ? JSON.stringify(arg) : String(arg)
      ).join(' ');
      window.consoleLogHistory.push(`[WARN] ${logString}`);

      // Always show warnings regardless of log settings
      originalConsoleWarn.apply(console, arguments);
    };

    // Limit history to last 500 entries
    const MAX_LOG_HISTORY = 500;
    setInterval(() => {
      if (window.consoleLogHistory.length > MAX_LOG_HISTORY) {
        window.consoleLogHistory = window.consoleLogHistory.slice(-MAX_LOG_HISTORY);
      }
    }, 10000); // Check every 10 seconds
  }

  // Check if showLogs flag is passed in context
  if (context && context.config && context.config.showLogs === true) {
    window.showDeviceLogs = true;
    console.log("Plugin initialized with showLogs enabled");
  } else {
    console.log("Plugin initialized with context:", context);
  }

  class DeviceEqUI {
    constructor() {
      this.deviceEqArea = document.getElementById('deviceEqArea');
      this.connectButton = this.deviceEqArea.querySelector('.connect-device');
      this.disconnectButton = this.deviceEqArea.querySelector('.disconnect-device');
      this.deviceNameElem = document.getElementById('deviceName');
      this.peqSlotArea = this.deviceEqArea.querySelector('.peq-slot-area');
      this.peqDropdown = document.getElementById('device-peq-slot-dropdown');
      this.pullButton = this.deviceEqArea.querySelector('.pull-filters-fromdevice');
      this.pushButton = this.deviceEqArea.querySelector('.push-filters-todevice');
      this.realtimeToggle = this.deviceEqArea.querySelector('.realtime-push-toggle');
      this.realtimeHint = this.deviceEqArea.querySelector('.realtime-push-hint');
      this.lastPushTime = 0;
      this.autoPushEnabled = false;
      this.autoPushTimer = null;
      this.pushInFlight = false;
      this.pendingAutoPush = false;
      this.lastAutoPushSignature = "";
      this.suppressAutoPushUntil = 0;
      this.pushCooling = false;

      this.useNetwork = false;
      this.currentDevice = null;
      this.initializeUI();
    }

    getPeqSlotDisplayName(name) {
      if (name === "Custom") {
        return "板载模式";
      }
      return name;
    }

    initializeUI() {
      this.disconnectButton.hidden = true;
      this.pullButton.hidden = true;
      this.pushButton.hidden = true;
      this.peqDropdown.hidden = true;
      this.peqSlotArea.hidden = true;
      if (this.realtimeToggle) {
        this.realtimeToggle.disabled = true;
      }
      this.updateRealtimeUi();
    }

    updatePushButtonState() {
      if (!this.pushButton || this.pushButton.hidden) {
        return;
      }
      const shouldDisable = !this.currentDevice || this.autoPushEnabled || this.pushCooling;
      this.pushButton.disabled = shouldDisable;
      this.pushButton.style.opacity = shouldDisable ? "0.5" : "";
      this.pushButton.style.cursor = shouldDisable ? "not-allowed" : "";
    }

    showConnectedState(device, connectionType, availableSlots, currentSlot) {
      this.connectButton.hidden = true;
      this.currentDevice = device;
      this.connectionType = connectionType;
      this.disconnectButton.hidden = false;
      this.deviceNameElem.textContent = device.model;
      this.populatePeqDropdown(availableSlots, currentSlot);
      this.pullButton.hidden = false;
      this.pushButton.hidden = false;
      this.peqDropdown.hidden = false;
      this.peqSlotArea.hidden = false;
      if (this.realtimeToggle) {
        this.realtimeToggle.disabled = false;
      }
      this.updateRealtimeUi();

      // Check if the push button should still be disabled based on lastPushTime
      const currentTime = Date.now();
      const cooldownTime = 220;

      if (currentTime < this.lastPushTime + cooldownTime) {
        // Button is still in cooldown period
        this.pushCooling = true;
        this.updatePushButtonState();

        // Set a new timeout for the remaining cooldown time
        const remainingTime = (this.lastPushTime + cooldownTime) - currentTime;
        setTimeout(() => {
          this.pushCooling = false;
          this.updatePushButtonState();
          console.log("Push button re-enabled after cooldown period");
        }, remainingTime);
      } else {
        this.pushCooling = false;
        this.updatePushButtonState();
      }
    }

    showDisconnectedState() {
      this.connectionType = "usb";  // Assume usb
      this.currentDevice = null;
      this.autoPushEnabled = false;
      this.pendingAutoPush = false;
      this.lastAutoPushSignature = "";
      this.suppressAutoPushUntil = 0;
      if (this.autoPushTimer) {
        clearTimeout(this.autoPushTimer);
        this.autoPushTimer = null;
      }
      this.connectButton.hidden = false;
      this.disconnectButton.hidden = true;
      this.deviceNameElem.textContent = 'None';
      this.peqDropdown.innerHTML = '<option value="-1">临时模式</option>';
      this.peqDropdown.hidden = true;
      this.pullButton.hidden = true;
      this.pushButton.hidden = true;
      this.peqSlotArea.hidden = true;
      if (this.realtimeToggle) {
        this.realtimeToggle.disabled = true;
      }
      this.updateRealtimeUi();
    }

    updateRealtimeUi() {
      if (!this.realtimeToggle) {
        return;
      }
      const isEnabled = this.autoPushEnabled && !!this.currentDevice;
      this.realtimeToggle.classList.toggle('is-on', isEnabled);
      this.realtimeToggle.classList.toggle('is-off', !isEnabled);
      this.updatePushButtonState();
      this.realtimeToggle.textContent = isEnabled ? '实时推送：开' : '实时推送：关';
      if (this.realtimeHint) {
        this.realtimeHint.textContent = isEnabled
          ? '拖动 EQ 后会自动推送到当前设备，已启用约 0.25 秒防抖。'
          : '关闭状态。建议先手动推送确认设备稳定后再启用实时推送。';
      }
    }

    populatePeqDropdown(slots, currentSlot) {
      // Clear existing options and add the default "PEQ Disabled" option
      this.peqDropdown.innerHTML = '<option value="-1">临时模式</option>';

      // Populate the dropdown with available slots
      slots.forEach(slot => {
        const option = document.createElement('option');
        option.value = slot.id;
        option.textContent = this.getPeqSlotDisplayName(slot.name);
        this.peqDropdown.appendChild(option);
      });

      // Set the selected option based on currentSlot
      if (currentSlot === -1) {
        // Select "PEQ Disabled"
        this.peqDropdown.selectedIndex = 0;
      } else {
        // Attempt to select the option matching currentSlot
        const matchingOption = Array.from(this.peqDropdown.options).find(option => option.value === String(currentSlot));
        if (matchingOption) {
          this.peqDropdown.value = currentSlot;
        } else {
          // If no matching option, default to "PEQ Disabled"
          this.peqDropdown.selectedIndex = 0;
        }
      }
    }
  }

  // Function to show toast messages
  // Parameters:
  // - message: The text message to display
  // - type: The type of toast (success, error, warning) with default 'success'
  // - timeout: The time in milliseconds before the toast disappears (default 5000ms)
  // - requireClick: If true, adds a "Continue" button that must be clicked to dismiss the toast (ignores timeout)
  //                 and returns a Promise that resolves when the button is clicked
  //
  // Example usage with await to block execution until user clicks Continue:
  // async function someFunction() {
  //   // Show a toast and wait for user to click Continue
  //   await showToast("Please confirm to continue", "warning", 0, true);
  //   // Code here will only execute after the user clicks Continue
  //   console.log("User clicked Continue");
  // }
  function showToast(message, type = 'success', timeout = 5000, requireClick = false) {
    return new Promise((resolve) => {
      // Create toast element
      const toast = document.createElement('div');
      toast.id = `device-toast-${type}`; // Type-specific ID

      // Create message container
      const messageContainer = document.createElement('div');
      messageContainer.textContent = message;
      toast.appendChild(messageContainer);

      // Set style based on type
      if (type === 'success') {
        toast.style.backgroundColor = '#4CAF50'; // Green
        toast.style.bottom = '80px'; // Bottom position for success
      } else if (type === 'error') {
        toast.style.backgroundColor = '#F44336'; // Red
        toast.style.top = '30px'; // Top position for error
        toast.style.bottom = 'auto'; // Override bottom
      } else if (type === 'warning') {
        toast.style.backgroundColor = '#FF9800'; // Orange
        toast.style.bottom = '30px'; // Bottom position for warning
      }

      // Common styles
      toast.style.color = 'white';
      toast.style.padding = '16px';
      toast.style.borderRadius = '4px';
      toast.style.position = 'fixed';
      toast.style.zIndex = '10000';
      toast.style.left = '50%';
      toast.style.transform = 'translateX(-50%)';
      toast.style.minWidth = '250px';
      toast.style.textAlign = 'center';
      toast.style.boxShadow = '0 2px 5px rgba(0,0,0,0.3)';

      // Check for existing toast of the same type
      const existingToast = document.getElementById(`device-toast-${type}`);
      if (existingToast) {
        // Check if the existing toast has a continue button (requireClick=true)
        const continueButton = existingToast.querySelector('button');
        if (continueButton) {
          // If there's an existing toast with a continue button, return early
          // to allow the user to interact with it
          return resolve(); // Resolve immediately since we're not showing a new toast
        }
        document.body.removeChild(existingToast);
      }

      // If requireClick is true, add a continue button
      if (requireClick) {
        // Add a continue button
        const continueButton = document.createElement('button');
        continueButton.textContent = 'Click here to Continue';
        continueButton.style.marginTop = '10px';
        continueButton.style.padding = '5px 15px';
        continueButton.style.backgroundColor = 'white';
        continueButton.style.color = toast.style.backgroundColor;
        continueButton.style.border = 'none';
        continueButton.style.borderRadius = '3px';
        continueButton.style.cursor = 'pointer';
        continueButton.style.fontWeight = 'bold';

        // Add click event to remove the toast and resolve the promise
        continueButton.addEventListener('click', () => {
          if (document.body.contains(toast)) {
            document.body.removeChild(toast);
          }
          resolve(); // Resolve the promise when the button is clicked
        });

        toast.appendChild(continueButton);
      } else {
        // Auto remove after xx seconds if requireClick is false
        setTimeout(() => {
          if (document.body.contains(toast)) {
            document.body.removeChild(toast);
          }
          resolve(); // Resolve the promise when the toast is automatically removed
        }, timeout);
      }

      // Add to document
      document.body.appendChild(toast);
    });
  }

  // Make showToast globally accessible for handlers
  window.showToast = showToast;

  function loadHtml() {
    // Set default values for configuration
    var headingTag = 'h4';

    // Override with context config values if available
    if (context && context.config) {
      if (context.config.devicePEQHeadingTag) {
          headingTag = context.config.devicePEQHeadingTag;
      }
    }
      // Define the HTML to insert
    const deviceEqHTML = `
        <div class="device-eq disabled" id="deviceEqArea">
        <style>
            .info-button {
      background: none;
      border: none;
      font-size: 1.2em;
      cursor: pointer;
      vertical-align: middle;
      margin-left: 6px;
      color: #555;
    }

    .info-button:hover {
      color: #000;
    }

    .modal.hidden {
      display: none;
    }

    .modal {
      position: fixed;
      z-index: 9999;
      left: 0;
      top: 0;
      width: 100%;
      height: 100%;
      overflow: auto;
      background-color: rgba(0,0,0,0.5);
      display: flex;
      justify-content: center;
      align-items: center;
    }

    .modal-content {
      background-color: #fff;
      padding: 20px 30px;
      border-radius: 12px;
      max-width: 500px;
      width: 90%;
      box-shadow: 0 2px 10px rgba(0,0,0,0.3);
      position: relative;
    }

    .modal-content .close {
      position: absolute;
      right: 16px;
      top: 12px;
      font-size: 1.4em;
      cursor: pointer;
    }
    .tabs {
      display: flex;
      gap: 10px;
      margin-bottom: 10px;
    }

    .tab-button {
      padding: 6px 12px;
      border: none;
      background-color: #eee;
      cursor: pointer;
      border-radius: 4px;
    }

    .tab-button.active {
      background-color: #ccc;
      font-weight: bold;
    }

    .tab-content {
      display: none;
    }

    .tab-content.active {
      display: block;
    }

    .sub-tabs {
      display: flex;
      gap: 8px;
      margin-bottom: 10px;
      border-bottom: 1px solid #ccc;
    }

    .sub-tab-button {
      padding: 4px 10px;
      border: none;
      background: #eee;
      cursor: pointer;
      border-radius: 4px 4px 0 0;
      font-size: 14px;
    }

    .sub-tab-button.active {
      background: #ccc;
      font-weight: bold;
    }

    .sub-tab-content {
      display: none;
    }

    .sub-tab-content.active {
      display: block;
    }

        /* Styles to force checkbox visibility */
    #tab-feedback input[type="checkbox"] {
      -webkit-appearance: checkbox; /* Force WebKit browsers to show default checkbox */
      appearance: compat-auto = checkbox;
      width: 16px;  /* Or any desired size */
      height: 16px; /* Or any desired size */
      opacity: 1;
      position: static; /* Ensure it's not positioned off-screen */
      visibility: visible;
      display: inline-block; /* Or block, depending on layout */
    }

        </style>
            <${headingTag}>设备 PEQ</${headingTag}>
<div class="settings-row">
                <button class="connect-device">连接设备</button>
                <div class="peq-slot-area">
                    <select name="device-peq-slot" id="device-peq-slot-dropdown">
                        <option value="None" selected>选择 PEQ 槽位</option>
                    </select>
                </div>
                <button class="disconnect-device">断开设备 <span id="deviceName">None</span></button>
            </div>
            <div class="filters-button">
                <button class="pull-filters-fromdevice">从设备读取</button>
                <button class="push-filters-todevice">推送到设备</button>
            </div>
            <div class="filters-button realtime-row">
                <button type="button" class="realtime-push-toggle is-off">实时推送：关</button>
                <span class="realtime-push-hint">关闭状态。建议先手动推送确认设备稳定后再启用实时推送。</span>
            </div>
        </div>
        <!-- Modal -->
        <div id="deviceInfoModal" class="modal hidden">
          <div class="modal-content">
            <button id="closeModalBtn" class="close" aria-label="Close Modal">&times;</button>
            <h3>About Device PEQ - v0.14</h3>

            <div class="tabs">
              <button class="tab-button active" data-tab="tab-overview">Overview</button>
              <button class="tab-button" data-tab="tab-supported">Supported Devices</button>
              <button class="tab-button" data-tab="tab-howto">How to Use</button>
              <button class="tab-button" data-tab="tab-feedback">Feedback</button>
            </div>

            <div id="tab-overview" class="tab-content active">
              <p>This section lets you connect to a compatible USB or network-connected audio device (such as Moondrop, Tanchjim, JDS Labs, WiiM, or other Walkplay-based products) and interact with its Parametric EQ (PEQ) settings.</p>

              <h4>Supported Brands & Manufacturers</h4>
              <ul>
                <li><strong>CrinEar:</strong> Protocol Max</li>
                <li><strong>FiiO:</strong> JA11, KA15, KA17, FX17, QX13</li>
                <li><strong>Moondrop:</strong> CDSP, Chu II DSP, Quark2, Rays </li>
                <li><strong>Tanchjim:</strong> Bunny DSP, Fission, One DSP, Stargate II </li>
                <li><strong>Truthear</strong> KeyX </li>
                <li><strong>EPZ:</strong> GM20 and TP13</li>
                <li><strong>KiwiEars:</strong> Allegro and Allegro Pro</li>
                <li><strong>JCally:</strong> JM20 Pro, JM12</li>
                <li><strong>Walkplay</strong> Most devices compatible with Walkplay Android APK</li>
                <li><strong>KTMicro</strong> Many KTMicro DSP devices should work </li>
                <li><strong>JDS Labs:</strong> Supporting the Element IV via USB Serial interface</li>
                <li><strong>Nothing:</strong> Headphone (1) via Serial USB or Bluetooth</li>
                <li><strong>WiiM:</strong> Supports limited pushing of parametric EQ over the home network</li>
                <li><strong>Experimental:</strong> Many more device's that have yet to be tested, will be marked as 'Experimental' but may work fine</li>
              </ul>
            </div>

            <div id="tab-supported" class="tab-content">
              <div class="sub-tabs">
                <button class="sub-tab-button active" data-subtab="sub-fiio">FiiO</button>
                <button class="sub-tab-button" data-subtab="sub-walkplay">Walkplay</button>
                <button class="sub-tab-button" data-subtab="sub-tanchjim">KTMicro</button>
                <button class="sub-tab-button" data-subtab="sub-jdslabs">JDS Labs</button>
                <button class="sub-tab-button" data-subtab="sub-nothing">Nothing</button>
                <button class="sub-tab-button" data-subtab="sub-wiim">WiiM</button>
              </div>

              <div id="sub-fiio" class="sub-tab-content active">
                <h5>FiiO / Jade Audio</h5>
                <p>Currently, I have tested the following FiiO devices: </p>
                <ul>
                  <li>JA11</li>
                  <li>KA17</li>
                  <li>KA15</li>
                  <li>FX17 (with usbc adapter)</li>
                  <li>QX13</li>
                  <li><em>Note:</em> Retro Nano has limited compatibility</li>
                </ul>
                <p>Mostly if a FiiO device works with their excellent Web-based PEQ editor at <a href="https://fiiocontrol.fiio.com" target="_blank">fiiocontrol.fiio.com</a> it should work here also</p>
              </div>

              <div id="sub-walkplay" class="sub-tab-content">
                <h5>Walkplay-Based Devices</h5>
                <p>Since Walkplay licenses their DSP technology to multiple brands, the following devices are known to work but many other devices might work:</p>
                <ul>
                  <li>Moondrop Quark2 DSP (IEM)</li>
                  <li>Moondrop Echo A (Dongle)</li>
                  <li>JCally JM20-Pro (Dongle)</li>
                  <li>Generic "Hi-Max" (Dongle)</li>
                  <li>EPZ G20 (IEM)</li>
                  <li>EPZ TP13 (Dongle)</li>
                </ul>
                <p>Walkplay also provide an excellent editor at <a href="https://peq.szwalkplay.com" target="_blank">peq.szwalkplay.com</a> and a decent Android App</p>
                <p>Note: One quirk with Walkplay devices is their PEQ WebApp and their Android App 'daches' what it thinks is the current PEQ for a device in the cloud (once you register) so values pushed <b>may not be visible</b> to their Website or Mobile App</p>
              </div>

              <div id="sub-tanchjim" class="sub-tab-content">
                <h5>KTMicro Devices</h5>
                <p>Currently, I have tested the following KTMicro DSP devices but many others should work</p>
                <ul>
                  <li>Moondrop CDSP</li>
                  <li>Moondrop Quark2</li>
                  <li>Tanchjim One DSP (IEM)</li>
                  <li>Tanchjim Bunny DSP (IEM)</li>
                  <li>Tanchjim Fission (IEM)</li>
                  <li>JCally JM12</li>
                </ul>
                <p>You also use the official Tanchjim Android App for EQ and device configuration.</p>
              </div>

            <div id="sub-jdslabs" class="sub-tab-content">
              <h5>JDS Labs</h5>
              <p>Supports PEQ control over USB Serial for compatible products like the JDS Labs Element IV, basically if it works on JDS Labs excellent <a href="https://core.jdslabs.com.">Core PEQ</a> it should work. You can push and pull filters directly to the device.</p>
              <p>Note: This option is only visible in advanced mode </p>
            </div>

            <div id="sub-nothing" class="sub-tab-content">
              <h5>Nothing</h5>
              <p>Beta support for Nothing Headphone (1) via Serial USB or Bluetooth connection. Supports reading and writing custom EQ profiles with up to 8 parametric filters.</p>
              <ul>
                <li>Nothing Headphone (1) - Beta support</li>
              </ul>
              <p>The Nothing headphones support multiple EQ profiles: Balanced, Voice, More Treble, More Bass, and Custom. Only the Custom profile supports writing parametric EQ filters.</p>
              <p>Note: This is experimental devicePEQ Bluetooth support and requires compatible browser with Web Serial API.</p>
            </div>

            <div id="sub-wiim" class="sub-tab-content">
              <h5>WiiM</h5>
              <p>Supports network-based PEQ settings for WiiM devices using HTTP APIs. Requires entering the local IP address of the device and selecting the audio source (e.g., Wi-Fi, Bluetooth).</p>
              <p>Note: This option is only visible in advanced mode </p>
            </div>
          </div>

            <div id="tab-howto" class="tab-content">
              <ul>
                <li><strong>Connect to Device:</strong> Open USB prompt and choose your device.</li>
                <li><strong>Select PEQ Slot:</strong> If supported, choose which EQ slot to view or modify.</li>
                <li><strong>Pull From Device:</strong> Read and load PEQ filter data into the interface.</li>
                <li><strong>Push To Device:</strong> Apply your PEQ filter settings back to the device.</li>
                <li><strong>Disconnect:</strong> Cleanly close the USB connection.</li>
              </ul>
              <p>a????? Please ensure your device is compatible and unlocked. Some may require the official app to enable USB EQ editing.</p>
            </div>

            <div id="tab-feedback" class="tab-content">
              <p><strong>Help us improve!</strong> Your feedback is valuable to us. Please let us know about your experience with Device PEQ.</p>

              <div style="margin-bottom: 10px; text-align: left; display: flex; align-items: center;">
                <input type="checkbox" id="modal-is-working-checkbox" style="margin-right: 8px;">
                <label for="modal-is-working-checkbox" style="font-size: 14px;">
                  Feature is working correctly
                </label>
              </div>

              <div style="margin-bottom: 10px; text-align: left; display: flex; align-items: center;">
                <input type="checkbox" id="modal-include-logs-checkbox" style="margin-right: 8px;">
                <label for="modal-include-logs-checkbox" style="font-size: 14px;">
                  Include console logs to help diagnose issues
                </label>
              </div>

              <div style="margin-bottom: 10px; text-align: left;">
                <label for="modal-device-name-input" style="font-size: 14px; display: block; margin-bottom: 5px;">
                  Device Name (optional):
                </label>
                <input type="text" id="modal-device-name-input" placeholder="Enter your device name" style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px;">
              </div>

              <div style="margin-bottom: 10px; text-align: left;">
                <label for="modal-comments-input" style="font-size: 14px; display: block; margin-bottom: 5px;">
                  Comments (optional):
                </label>
                <textarea id="modal-comments-input" placeholder="Please describe any issues you're experiencing or suggestions you have..." style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; min-height: 100px;"></textarea>
              </div>

              <div style="text-align: center; margin-top: 15px;">
                <button id="modal-feedback-button" class="button">Send Feedback</button>
                <div id="modal-feedback-status" style="margin-top: 10px; display: none;"></div>
              </div>
            </div>
          </div>
        </div>
    `;
    // More flexible way to insert HTML into the DOM
    var placement = 'afterend';
    var anchorDiv = '.extra-eq';
    if (context && context.config ) {
        if (context.config.devicePEQPlacement) {
            placement = context.config.devicePEQPlacement;
        }
        if (context.config.devicePEQAnchorDiv) {
            anchorDiv = context.config.devicePEQAnchorDiv;
        }
    }

      // Find the <div class="extra-eq"> element
    const extraEqElement = document.querySelector(anchorDiv);

    if (extraEqElement) {
      // Insert the new HTML below the "extra-eq" div
      extraEqElement.insertAdjacentHTML(placement, deviceEqHTML);
      // console.log('Device EQ UI added ' + placement + ' <div class="' + deviceEqHTML + '">');
    } else {
      console.error('Element <div class="extra-eq"> not found in the DOM.');
    }
// Open modal
    const deviceInfoBtn = document.getElementById('deviceInfoBtn');
    const deviceInfoModal = document.getElementById('deviceInfoModal');
    const closeModalBtn = document.getElementById('closeModalBtn');

    if (deviceInfoBtn && deviceInfoModal) {
      deviceInfoBtn.addEventListener('click', () => {
        deviceInfoModal.classList.remove('hidden');
      });
    }

// Close modal via close button
    if (closeModalBtn && deviceInfoModal) {
      closeModalBtn.addEventListener('click', () => {
        deviceInfoModal.classList.add('hidden');
      });
    }

// Optional: close modal when clicking outside content
    if (deviceInfoModal) {
      deviceInfoModal.addEventListener('click', (e) => {
        if (e.target.id === 'deviceInfoModal') {
          deviceInfoModal.classList.add('hidden');
        }
      });
    }

    document.querySelectorAll(".tab-button").forEach(btn => {
      btn.addEventListener("click", () => {
        // Toggle active tab button
        document.querySelectorAll(".tab-button").forEach(b => b.classList.remove("active"));
        btn.classList.add("active");

        // Show correct tab content
        const tabId = btn.getAttribute("data-tab");
        document.querySelectorAll(".tab-content").forEach(c => c.classList.remove("active"));
        document.getElementById(tabId).classList.add("active");
      });
    });

    document.querySelectorAll(".sub-tab-button").forEach(button => {
      button.addEventListener("click", () => {
        // Update button state
        document.querySelectorAll(".sub-tab-button").forEach(b => b.classList.remove("active"));
        button.classList.add("active");

        // Show corresponding sub-tab
        const tabId = button.getAttribute("data-subtab");
        document.querySelectorAll(".sub-tab-content").forEach(c => c.classList.remove("active"));
        document.getElementById(tabId).classList.add("active");
      });
    });

    // Function to collect recent console logs
    function collectConsoleLogs() {
      // Return the last 100 console logs that contain plugin-related keywords
      if (!window.consoleLogHistory) {
        return "No console logs available";
      }

      // Filter logs related to the plugin
      const pluginLogs = window.consoleLogHistory.filter(log =>
        log.includes("Device") ||
        log.includes("PEQ") ||
        log.includes("USB") ||
        log.includes("plugin") ||
        log.includes("connector")
      );

      // Return the last 100 logs or all if less than 100
      return pluginLogs.slice(-100).join("\n");
    }

    // Set up feedback form submission
    document.getElementById("modal-feedback-button").addEventListener("click", () => {
      // Get values from form elements
      const includeLogsCheckbox = document.getElementById("modal-include-logs-checkbox");
      const isWorkingCheckbox = document.getElementById("modal-is-working-checkbox");
      const deviceNameInput = document.getElementById("modal-device-name-input");
      const commentsInput = document.getElementById("modal-comments-input");
      const statusContainer = document.getElementById("modal-feedback-status");

      // If console log is empty, capture it now
      let logs = "";
      if (includeLogsCheckbox && includeLogsCheckbox.checked) {
        logs = collectConsoleLogs();
      }

      // Show status message
      statusContainer.style.display = "block";
      statusContainer.style.padding = "8px";
      statusContainer.style.borderRadius = "4px";
      statusContainer.style.textAlign = "center";
      statusContainer.style.backgroundColor = "#f8f9fa";
      statusContainer.style.color = "#333";
      statusContainer.textContent = "Submitting your feedback...";

      // Submit to Google Form
      submitFeedbackToGoogleForm(
        deviceNameInput && deviceNameInput.value ? deviceNameInput.value : "Not specified",
        commentsInput,
        logs,
        isWorkingCheckbox && isWorkingCheckbox.checked,
        statusContainer
      );
    });

    async function submitFeedbackToGoogleForm(deviceName, comments, logs, isWorking, statusContainer) {
      const formData = new URLSearchParams();
      formData.append('entry.1909598303', deviceName);
      formData.append('entry.1928983035', comments && comments.value ? comments.value : "No comments provided");
      formData.append('entry.466843002', logs || "No logs available");
      formData.append('entry.1088832316', isWorking ? "Working" : "Not Working");

      try {
        const response = await fetch('https://docs.google.com/forms/d/e/1FAIpQLSfSaNpdpAvd39tOupDqzyUW_aFEVawywAz4xls4m1z2_T3BOQ/formResponse', {
          method: 'POST',
          mode: 'no-cors', // Google Forms requires no-cors mode
          headers: {
            'Content-Type': 'application/x-www-form-urlencoded',
          },
          body: formData.toString()
        });

        // Note: With no-cors mode, we can't access the response details
        // But we can assume it worked if no error was thrown
        console.log("Google Form Submission Completed");

        statusContainer.style.backgroundColor = "#d4edda";
        statusContainer.style.color = "#155724";
        statusContainer.textContent = "Thank you for your feedback!";

        setTimeout(() => {
          statusContainer.style.display = "none";
        }, 3000);

      } catch (error) {
        console.error("Error submitting to Google Form:", error);
        statusContainer.style.backgroundColor = "#f8d7da";
        statusContainer.style.color = "#721c24";
        statusContainer.textContent = "Failed to submit feedback.";
      }
    }
  }

  try {
    // Dynamically import USB and Network connectors
    const UsbHIDConnector = await window.DevicePeqBundle.UsbHIDConnector;
    console.log('UsbHIDConnector loaded');

    const UsbSerialConnector = await window.DevicePeqBundle.UsbSerialConnector;
    console.log('UsbSerialConnector loaded');

    const NetworkDeviceConnector = await window.DevicePeqBundle.NetworkDeviceConnector;
    console.log('NetworkDeviceConnector loaded');

    if ('hid' in navigator || 'serial' in navigator) {
      if (document.readyState === 'loading') {
        document.addEventListener('DOMContentLoaded', () => initializeDeviceEQ());
      } else {
        // DOM is already loaded
        initializeDeviceEQ();
      }

      function initializeDeviceEQ() {
        // Dynamically load the HTML we need in the right place
        loadHtml();

        const deviceEqUI = new DeviceEqUI();
        const statusElem = document.getElementById("status");

        function setStatusText(text) {
          if (statusElem) {
            statusElem.textContent = text || "";
          }
        }

        const PUSH_COOLDOWN_MS = 220;
        const AUTO_PUSH_DEBOUNCE_MS = 260;

        function setPushCoolingState(isCooling) {
          deviceEqUI.pushCooling = !!isCooling;
          deviceEqUI.updatePushButtonState();
        }

        function getSelectedSlotId(allowDisabled = false) {
          if (!deviceEqUI.peqDropdown) {
            return null;
          }
          const rawValue = deviceEqUI.peqDropdown.value;
          if (rawValue === undefined || rawValue === null || rawValue === "") {
            return null;
          }
          const parsedValue = typeof rawValue === "string" && !isNaN(parseInt(rawValue, 10))
            ? parseInt(rawValue, 10)
            : rawValue;
          if (!allowDisabled && parsedValue === -1) {
            return null;
          }
          return parsedValue;
        }

        function collectPushPayload(allowDisabled = false) {
          const filters = context.elemToFilters(true);
          return {
            device: deviceEqUI.currentDevice,
            connectionType: deviceEqUI.connectionType,
            selectedSlot: getSelectedSlotId(allowDisabled),
            filters,
            preampGain: context.calcEqDevPreamp(filters)
          };
        }

        function getPushPayloadSignature(payload) {
          return JSON.stringify({
            connectionType: payload.connectionType || "usb",
            selectedSlot: payload.selectedSlot,
            preampGain: Math.round((payload.preampGain || 0) * 10) / 10,
            filters: (payload.filters || []).map((filter) => ({
              disabled: !!filter.disabled,
              type: filter.type,
              freq: filter.freq,
              q: filter.q,
              gain: filter.gain
            }))
          });
        }

        async function disconnectCurrentDevice() {
          if (deviceEqUI.connectionType == "network") {
            await NetworkDeviceConnector.disconnectDevice();
          } else if (deviceEqUI.connectionType == "usb") {
            await UsbHIDConnector.disconnectDevice();
          } else if (deviceEqUI.connectionType == "serial") {
            await UsbSerialConnector.disconnectDevice();
          }
        }

        async function pushCurrentFilters(options = {}) {
          const silent = options.silent === true;
          const source = options.source || "manual";
          const allowDisabledSlot = options.allowDisabledSlot === true;

          if (deviceEqUI.pushInFlight) {
            if (source === "realtime") {
              deviceEqUI.pendingAutoPush = true;
            }
            return false;
          }

          const currentTime = Date.now();
          if (currentTime < deviceEqUI.lastPushTime + PUSH_COOLDOWN_MS) {
            if (source === "realtime") {
              deviceEqUI.pendingAutoPush = true;
              const waitMs = Math.max(0, (deviceEqUI.lastPushTime + PUSH_COOLDOWN_MS) - currentTime);
              if (deviceEqUI.autoPushTimer) {
                clearTimeout(deviceEqUI.autoPushTimer);
              }
              deviceEqUI.autoPushTimer = setTimeout(() => {
                deviceEqUI.autoPushTimer = null;
                scheduleRealtimePush("cooldown");
              }, waitMs);
            }
            return false;
          }

          const payload = collectPushPayload(allowDisabledSlot);
          if (!payload.device || payload.selectedSlot === null) {
            if (!silent) {
              showToast("临时模式无法注入", "error");
            }
            setStatusText("推送失败：未连接设备或未选择有效的 PEQ 槽位。");
            return false;
          }
          if (!payload.filters.length) {
            if (!silent) {
              showToast("Please add at least one filter before pushing.", "error");
            }
            setStatusText("推送失败：当前还没有可写入的滤波器。");
            return false;
          }

          deviceEqUI.pushInFlight = true;
          try {
            let disconnect = false;
            if (payload.connectionType == "network") {
              disconnect = await NetworkDeviceConnector.pushToDevice(payload.device, payload.selectedSlot, payload.preampGain, payload.filters);
            } else if (payload.connectionType == "usb") {
              disconnect = await UsbHIDConnector.pushToDevice(payload.device, payload.selectedSlot, payload.preampGain, payload.filters);
            } else if (payload.connectionType == "serial") {
              disconnect = await UsbSerialConnector.pushToDevice(payload.device, payload.selectedSlot, payload.preampGain, payload.filters);
            }

            deviceEqUI.lastPushTime = Date.now();
            deviceEqUI.lastAutoPushSignature = getPushPayloadSignature(payload);
            setPushCoolingState(true);
            setTimeout(() => {
              setPushCoolingState(false);
            }, PUSH_COOLDOWN_MS);

            if (disconnect) {
              await disconnectCurrentDevice();
              deviceEqUI.showDisconnectedState();
              if (!silent) {
                showToast("PEQ Saved - Restarting", "success");
              }
              setStatusText("设备已写入 EQ，设备可能正在重启或重新连接。");
            } else {
              if (!silent) {
                showToast("PEQ Successfully pushed to device", "success");
              }
              setStatusText(source === "realtime" ? "已实时推送到设备，可直接听当前 EQ 效果。" : "已推送当前 EQ 到设备。");
            }
            return true;
          } catch (error) {
            console.error("Error pushing PEQ filters:", error);
            const message = error && error.message ? error.message : "Unknown error";
            showToast(source === "realtime" ? `实时推送失败：${message}` : "Failed to push PEQ filters to device.", "error");
            setStatusText(source === "realtime" ? `实时推送失败：${message}` : `推送失败：${message}`);
            await disconnectCurrentDevice();
            deviceEqUI.showDisconnectedState();
            return false;
          } finally {
            deviceEqUI.pushInFlight = false;
            if (deviceEqUI.pendingAutoPush && deviceEqUI.autoPushEnabled && deviceEqUI.currentDevice) {
              deviceEqUI.pendingAutoPush = false;
              scheduleRealtimePush("pending");
            }
          }
        }

        function scheduleRealtimePush(reason) {
          if (!deviceEqUI.autoPushEnabled || !deviceEqUI.currentDevice) {
            return;
          }
          if (Date.now() < deviceEqUI.suppressAutoPushUntil) {
            return;
          }
          const payload = collectPushPayload(false);
          if (!payload.device || payload.selectedSlot === null || !payload.filters.length) {
            return;
          }
          const nextSignature = getPushPayloadSignature(payload);
          if (nextSignature === deviceEqUI.lastAutoPushSignature) {
            return;
          }
          if (deviceEqUI.pushInFlight) {
            deviceEqUI.pendingAutoPush = true;
            return;
          }
          if (deviceEqUI.autoPushTimer) {
            clearTimeout(deviceEqUI.autoPushTimer);
          }
          setStatusText("EQ 已变化，等待实时推送...");
          deviceEqUI.autoPushTimer = setTimeout(async () => {
            deviceEqUI.autoPushTimer = null;
            await pushCurrentFilters({ silent: true, source: "realtime" });
          }, AUTO_PUSH_DEBOUNCE_MS);
        }

        // Show the Connect button if WebHID is supported
        deviceEqUI.deviceEqArea.classList.remove('disabled');
        deviceEqUI.connectButton.hidden = false;
        deviceEqUI.disconnectButton.hidden = true;
        setStatusText("可连接模式：USB HID / Serial / Network。仅兼容受支持的 Device PEQ 设备。");

        if (deviceEqUI.realtimeToggle) {
          deviceEqUI.realtimeToggle.addEventListener('click', () => {
            if (!deviceEqUI.currentDevice) {
              setStatusText("请先连接支持 Device PEQ 的设备，再启用实时推送。");
              return;
            }
            deviceEqUI.autoPushEnabled = !deviceEqUI.autoPushEnabled;
            deviceEqUI.pendingAutoPush = false;
            deviceEqUI.lastAutoPushSignature = "";
            if (deviceEqUI.autoPushTimer) {
              clearTimeout(deviceEqUI.autoPushTimer);
              deviceEqUI.autoPushTimer = null;
            }
            deviceEqUI.updateRealtimeUi();
            if (deviceEqUI.autoPushEnabled) {
              setStatusText("实时推送已开启。拖动 EQ 后会自动写入设备。");
              scheduleRealtimePush("toggle-on");
            } else {
              setStatusText("实时推送已关闭。当前仍可使用手动推送。");
            }
          });
        }

        document.addEventListener('UpdateExtensionFilters', () => {
          scheduleRealtimePush("local-eq-change");
        });

        // Connect Button Event Listener
        deviceEqUI.connectButton.addEventListener('click', async () => {
          try {
            let selection =  {connectionType: "usb"}; // Assume usb only by default
            if (context.config.advanced) {
              // Show a custom dialog to select Network or USB
              selection = await showDeviceSelectionDialog();
            }

            if (selection.connectionType == "network") {
              if (!selection.ipAddress) {
                showToast("Please enter a valid IP address.", "error");
                setStatusText("连接失败：未填写网络设备 IP 地址。");
                return;
              }
              setCookie("networkDeviceIP", selection.ipAddress, 30); // Save IP for 30 days
              setCookie("networkDeviceType", selection.deviceType, 30); // Store device type for 30 days

              // Connect via Network using the provided IP
              const device = await NetworkDeviceConnector.getDeviceConnected(selection.ipAddress, selection.deviceType);
              if (device?.handler == null) {
                showToast("Sorry, this network device is not currently supported.", "error");
                setStatusText(`连接失败：暂不支持该网络设备类型 ${selection.deviceType}。`);
                await NetworkDeviceConnector.disconnectDevice();
                return;
              }
              if (device) {
                setStatusText(`已连接网络设备：${selection.deviceType} @ ${selection.ipAddress}`);
                deviceEqUI.showConnectedState(
                  device,
                  selection.connectionType,
                  await NetworkDeviceConnector.getAvailableSlots(device),
                  await NetworkDeviceConnector.getCurrentSlot(device)
                );

                // Check if device supports fewer filters than currently in context
                const currentFilters = context.elemToFilters(true);
                if (currentFilters.length > device.modelConfig.maxFilters) {
                  console.warn(`Device only supports ${device.modelConfig.maxFilters} PEQ filters but ${currentFilters.length} filters are currently loaded`);
                  if (window.showToast) {
                    window.showToast(`Warning: This device only supports ${device.modelConfig.maxFilters} PEQ filters, but you currently have ${currentFilters.length} filters loaded. Only the first ${device.modelConfig.maxFilters} will be applied when pushed.`, "warning", 10000, true);
                  }
                }
              }
              // Emit custom event for device connection
              const event = new CustomEvent('devicePEQ.deviceConnected', { detail: { connectionType: selection.connectionType, device: device } });
              window.dispatchEvent(event);
            } else if (selection.connectionType == "usb") {
              // Connect via USB and show the HID device picker
              const device = await UsbHIDConnector.getDeviceConnected();
              if (device?.handler == null) {
                showToast("Sorry, this USB device is not currently supported.", "error");
                setStatusText("连接失败：当前 USB HID 设备不在支持列表中。");
                await UsbHIDConnector.disconnectDevice();
                return;
              }
              if (device) {
                setStatusText(`已连接 USB HID 设备：${device.model}`);
                // Check if the device is experimental
                const isExperimental = device.modelConfig?.experimental === true;

                if (isExperimental) {
                  // Enable logs for experimental devices
                  showDeviceLogs = true;
                  console.log(`Enabling detailed logs for experimental device: ${device.model}`);

                  // Show warning popup for experimental devices
                  const proceedWithConnection = await showExperimentalDeviceWarning(device.model);
                  if (!proceedWithConnection) {
                    await UsbHIDConnector.disconnectDevice();
                    return;
                  }
                }

                deviceEqUI.showConnectedState(
                  device,
                  selection.connectionType,
                  await UsbHIDConnector.getAvailableSlots(device),
                  await UsbHIDConnector.getCurrentSlot(device)
                );

                // Check if device supports fewer filters than currently in context
                const currentFilters = context.elemToFilters(true);
                if (currentFilters.length > device.modelConfig.maxFilters) {
                  console.warn(`Device only supports ${device.modelConfig.maxFilters} PEQ filters but ${currentFilters.length} filters are currently loaded`);
                  if (window.showToast) {
                    window.showToast(`Warning: This device only supports ${device.modelConfig.maxFilters} PEQ filters, but you currently have ${currentFilters.length} filters loaded. Only the first ${device.modelConfig.maxFilters} will be applied when pushed.`, "warning", 10000, true);
                  }
                }

                device.rawDevice.addEventListener('disconnect', () => {
                  console.log(`Device ${device.rawDevice.productName} disconnected.`);
                  deviceEqUI.showDisconnectedState();
                });
              }
              // Emit custom event for device connection
              const event = new CustomEvent('devicePEQ.deviceConnected', { detail: { connectionType: selection.connectionType, device: device } });
              window.dispatchEvent(event);
            } else if (selection.connectionType == "serial") {
              // Connect via USB and show the Serial device picker
              const device = await UsbSerialConnector.getDeviceConnected();
              if (device?.handler == null) {
                showToast("Sorry, this USB Serial device is not currently supported.", "error");
                setStatusText("连接失败：当前 Serial / Bluetooth 设备不在支持列表中。");
                await UsbSerialConnector.disconnectDevice();
                return;
              }
              if (device) {
                setStatusText(`已连接 Serial / Bluetooth 设备：${device.model}`);
                // Check if the device is experimental
                const isExperimental = device.modelConfig?.experimental === true;

                if (isExperimental) {
                  // Enable logs for experimental devices
                  window.showDeviceLogs = true;
                  console.log(`Enabling detailed logs for experimental serial device: ${device.model}`);

                  // Show warning popup for experimental devices
                  const proceedWithConnection = await showExperimentalDeviceWarning(device.model);
                  if (!proceedWithConnection) {
                    await UsbSerialConnector.disconnectDevice();
                    return;
                  }
                }

                deviceEqUI.showConnectedState(
                  device,
                  selection.connectionType,
                  await UsbSerialConnector.getAvailableSlots(device),
                  await UsbSerialConnector.getCurrentSlot(device)
                );

                // Check if device supports fewer filters than currently in context
                const currentFilters = context.elemToFilters(true);
                if (currentFilters.length > device.modelConfig.maxFilters) {
                  console.warn(`Device only supports ${device.modelConfig.maxFilters} PEQ filters but ${currentFilters.length} filters are currently loaded`);
                  if (window.showToast) {
                    window.showToast(`Warning: This device only supports ${device.modelConfig.maxFilters} PEQ filters, but you currently have ${currentFilters.length} filters loaded. Only the first ${device.modelConfig.maxFilters} will be applied when pushed.`, "warning", 10000, true);
                  }
                }

                device.rawDevice.addEventListener('disconnect', () => {
                  console.log(`Device ${device.rawDevice.productName} disconnected.`);
                  deviceEqUI.showDisconnectedState();
                });
              }
              // Emit custom event for device connection
              const event = new CustomEvent('devicePEQ.deviceConnected', { detail: { connectionType: selection.connectionType, device: device } });
              window.dispatchEvent(event);
            }
          } catch (error) {
            console.error("Error connecting to device:", error);
            const message = error && error.message ? error.message : "未知错误";
            showToast(`Failed to connect to the device: ${message}`, "error");
            setStatusText(`连接失败：${message}`);
          }
        });


        // Cookie functions
        function setCookie(name, value, days) {
          let expires = "";
          if (days) {
            const date = new Date();
            date.setTime(date.getTime() + days * 24 * 60 * 60 * 1000);
            expires = "; expires=" + date.toUTCString();
          }
          document.cookie = name + "=" + value + "; path=/" + expires;
        }

        function getCookie(name) {
          const nameEQ = name + "=";
          const cookies = document.cookie.split(';');
          for (let i = 0; i < cookies.length; i++) {
            let c = cookies[i];
            while (c.charAt(0) === ' ') c = c.substring(1, c.length);
            if (c.indexOf(nameEQ) === 0) return c.substring(nameEQ.length, c.length);
          }
          return null;
        }

        function deleteCookie(name) {
          document.cookie = name + "=; path=/; expires=Thu, 01 Jan 1970 00:00:00 UTC";
        }

        // Function to show warning for experimental devices
        function showExperimentalDeviceWarning(deviceName) {
          return new Promise((resolve) => {
            const dialogHTML = `
              <div id="experimental-device-dialog" style="
                  position: fixed;
                  top: 50%;
                  left: 50%;
                  transform: translate(-50%, -50%);
                  background: #fff;
                  padding: 20px;
                  border-radius: 8px;
                  box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.3);
                  text-align: center;
                  z-index: 10000;
                  min-width: 340px;
                  font-family: Arial, sans-serif;
              ">
                <h3 style="margin-bottom: 10px; color: #d9534f;">Experimental Device Warning</h3>
                <p style="color: black; margin-bottom: 15px;">
                  <strong>${deviceName}</strong> is marked as an experimental device.
                  This means it hasn't been fully tested and while it may work perfectly, it may not work as expected.
                </p>
                <p style="color: black; margin-bottom: 15px;">
                  If the device is working for you please consider submiting feedback below, and we will mark it as not experimental in the next release.
                  If you noticed any issues, please disconnect the device and then come back here and submit feedback below.
                </p>
                <p style="color: black; margin-bottom: 15px;">
                  Would you like to proceed with the connection anyway?
                </p>

                <div style="display: flex; justify-content: center; gap: 10px; margin-bottom: 15px;">
                  <button id="proceed-button" style="padding: 8px 15px; background: #5cb85c; color: white; border: none; border-radius: 4px; cursor: pointer;">
                    Proceed
                  </button>
                  <button id="cancel-button" style="padding: 8px 15px; background: #d9534f; color: white; border: none; border-radius: 4px; cursor: pointer;">
                    Cancel
                  </button>
                </div>

                <div style="border-top: 1px solid #eee; padding-top: 15px;">
                  <p style="color: black; margin-bottom: 10px;">
                    <strong>Help us improve!</strong> If you proceed, please consider providing feedback:
                  </p>
                  <div style="margin-bottom: 10px; text-align: left; display: flex; align-items: center;">
                    <input type="checkbox" id="is-working-checkbox" style="margin-right: 8px;">
                    <label for="is-working-checkbox" style="color: black; font-size: 14px;">
                      Feature is working correctly
                    </label>
                  </div>
                  <div style="margin-bottom: 10px; text-align: left; display: flex; align-items: center;">
                    <input type="checkbox" id="include-logs-checkbox" style="margin-right: 8px;">
                    <label for="include-logs-checkbox" style="color: black; font-size: 14px;">
                      Include console logs to help diagnose issues
                    </label>
                  </div>
                  <div style="margin-bottom: 10px; text-align: left;">
                    <label for="comments-input" style="color: black; font-size: 14px; display: block; margin-bottom: 5px;">
                      Comments (optional):
                    </label>
                    <textarea id="comments-input" placeholder="Please describe any issues you're experiencing..." style="width: 100%; padding: 8px; border: 1px solid #ccc; border-radius: 4px; min-height: 60px;"></textarea>
                  </div>
                  <button id="feedback-button" style="padding: 8px 15px; background: #5bc0de; color: white; border: none; border-radius: 4px; cursor: pointer;">
                    Send Feedback
                  </button>
                </div>
              </div>
            `;

            // Force checkboxes
            const styleFix = document.createElement("style");
            styleFix.innerHTML = `
              input[type="checkbox"] {
                appearance: auto !important;
                -webkit-appearance: auto !important;
                width: 16px;
                height: 16px;
                vertical-align: middle;
              }
            `;
            document.head.appendChild(styleFix);

            const dialogContainer = document.createElement("div");
            dialogContainer.innerHTML = dialogHTML;
            document.body.appendChild(dialogContainer);

            // Proceed button
            document.getElementById("proceed-button").addEventListener("click", () => {
              document.body.removeChild(dialogContainer);
              resolve(true);
            });

            // Cancel button
            document.getElementById("cancel-button").addEventListener("click", () => {
              document.body.removeChild(dialogContainer);
              resolve(false);
            });

            // Function to collect recent console logs
            function collectConsoleLogs() {
              // Return the last 100 console logs that contain plugin-related keywords
              if (!window.consoleLogHistory) {
                return "No console logs available";
              }

              // Filter logs related to the plugin
              const pluginLogs = window.consoleLogHistory.filter(log =>
                log.includes("Device") ||
                log.includes("PEQ") ||
                log.includes("USB") ||
                log.includes("plugin") ||
                log.includes("connector")
              );

              // Return the last 100 logs or all if less than 100
              return pluginLogs.slice(-100).join("\n");
            }

            // Feedback button
            document.getElementById("feedback-button").addEventListener("click", () => {
              // Get values from form elements
              const includeLogsCheckbox = document.getElementById("include-logs-checkbox");
              const isWorkingCheckbox = document.getElementById("is-working-checkbox");
              const commentsInput = document.getElementById("comments-input");

              // If console log is empty, capture it now
              let logs = "";
              if (includeLogsCheckbox && includeLogsCheckbox.checked) {
                logs = collectConsoleLogs();
              }

              // Show status message
              const statusContainer = document.createElement("div");
              statusContainer.style.marginTop = "10px";
              statusContainer.style.padding = "8px";
              statusContainer.style.borderRadius = "4px";
              statusContainer.style.textAlign = "center";
              statusContainer.style.backgroundColor = "#f8f9fa";
              statusContainer.style.color = "#333";
              statusContainer.textContent = "Submitting your feedback...";

              // Add status container after the feedback button
              document.getElementById("feedback-button").insertAdjacentElement('afterend', statusContainer);

              // Submit to Google Form
              submitToGoogleFormProxy(deviceName, commentsInput, logs, isWorkingCheckbox && isWorkingCheckbox.checked, statusContainer);
            });

            async function submitToGoogleFormProxy(deviceName, comments, logs, isWorking, statusContainer) {
              const formData = new URLSearchParams();
              formData.append('entry.1909598303', deviceName);
              formData.append('entry.1928983035', comments && comments.value ? comments.value : "No comments provided");
              formData.append('entry.466843002', logs || "No logs available");
              formData.append('entry.1088832316', isWorking ? "Working" : "Not Working");

              try {
                const response = await fetch('https://docs.google.com/forms/d/e/1FAIpQLSfSaNpdpAvd39tOupDqzyUW_aFEVawywAz4xls4m1z2_T3BOQ/formResponse', {
                  method: 'POST',
                  mode: 'no-cors', // Google Forms requires no-cors mode
                  headers: {
                    'Content-Type': 'application/x-www-form-urlencoded',
                  },
                  body: formData.toString()
                });

                // Note: With no-cors mode, we can't access the response details
                // But we can assume it worked if no error was thrown
                console.log("Google Form Submission Completed");

                statusContainer.style.backgroundColor = "#d4edda";
                statusContainer.style.color = "#155724";
                statusContainer.textContent = "Thank you for your feedback!";

                setTimeout(() => {
                  if (statusContainer.parentNode) {
                    statusContainer.parentNode.removeChild(statusContainer);
                  }
                }, 3000);

              } catch (error) {
                console.error("Error submitting to Google Form Proxy:", error);
                statusContainer.style.backgroundColor = "#f8d7da";
                statusContainer.style.color = "#721c24";
                statusContainer.textContent = "Failed to submit feedback.";
              }
            }
          });
        }

        function showDeviceSelectionDialog() {
          return new Promise((resolve) => {
            const storedIP = getCookie("networkDeviceIP") || "";
            const storedDeviceType = getCookie("networkDeviceType") || "WiiM";

            const dialogHTML = `
      <div id="device-selection-dialog" style="
          position: fixed;
          top: 50%;
          left: 50%;
          transform: translate(-50%, -50%);
          background: #fff;
          padding: 20px;
          border-radius: 8px;
          box-shadow: 0px 4px 10px rgba(0, 0, 0, 0.3);
          text-align: center;
          z-index: 10000;
          min-width: 340px;
          font-family: Arial, sans-serif;
      ">
        <h3 style="margin-bottom: 10px; color: black;">Select Connection Type</h3>
        <p style="color: black;">Choose how you want to connect to your device.</p>

        <!-- Selection Buttons (Vertical Layout) -->
        <div style="display: flex; flex-direction: column; align-items: center; width: 100%;">
          <button id="usb-hid-button" style="margin: 5px 0; padding: 10px 15px; font-size: 14px; background: #007BFF; color: #fff; border: none; border-radius: 4px; cursor: pointer; width: 80%;">USB Device</button>
          <button id="usb-serial-button" style="margin: 5px 0; padding: 10px 15px; font-size: 14px; background: #6f42c1; color: #fff; border: none; border-radius: 4px; cursor: pointer; width: 80%;">Serial USB or Bluetooth Device</button>
          <button id="network-button" style="margin: 5px 0; padding: 10px 15px; font-size: 14px; background: #28a745; color: #fff; border: none; border-radius: 4px; cursor: pointer; width: 80%;">Network</button>
        </div>

        <!-- IP Address Input -->
        <input type="text" id="ip-input" placeholder="Enter IP Address" value="${storedIP}" style="display: none; margin-top: 10px; width: 80%;">
        <!-- Test IP Button (Initially Hidden) -->
        <button id="test-ip-button" style="display: none; margin-top: 10px; padding: 8px 12px; font-size: 13px; background: #ffc107; color: #000; border: none; border-radius: 4px; cursor: pointer;">
          Test IP Address (Open in Browser Tab)
        </button>
        <!-- Network Options -->
        <div id="network-options" style="display: none; margin-top: 15px; text-align: left; background: #f9f9f9; padding: 12px; border-radius: 6px; font-size: 14px; color: #222;">
          <p style="margin-bottom: 10px;"><strong>a????? Advanced Network Configuration</strong></p>
          <p>This section requires some basic understanding of networking. Please continue only if you are familiar with concepts like IP addresses and self-signed certificates.</p>

          <p><strong>Why the warning?</strong></p>
          <p>Devices like the <strong>WiiM</strong> expose a local web server for configuration (similar to how home routers work). These devices often use a <em>self-signed certificate</em> to enable HTTPS, which is secure but <b>not trusted</b> by your browser by default.</p>

          <p>As a result, when trying to connect via a web browser, you may see a <strong>security warning</strong> (e.g., "Your connection is not private"). This is normal and expected. If you choose to <b>trust the device</b> and accept the warning, this tool will attempt to access its PEQ API.</p>

          <p>Note: Due to this security restriction I can only push the PEQ filters to the WiiM Device and cannot read them. They will be called HeadphoneEQ when pushed.</p>

          <p>If you're okay proceed you can at least push the PEQ to this device, reading from the device breaks this security and will fail</p>
          <div style="margin-top: 10px; text-align: center;">
            <label style="display: inline-flex; align-items: center; gap: 5px; margin-right: 15px; font-weight: bold; color: black;">
              <input type="radio" name="network-device" value="WiiM" ${storedDeviceType === "WiiM" ? "checked" : ""} style="width: 18px; height: 18px;"> WiiM
            </label>
            <label style="display: inline-flex; align-items: center; gap: 5px; font-weight: bold; color: gray;">
              <input type="radio" name="network-device" value="coming-soon" disabled ${storedDeviceType === "coming-soon" ? "checked" : ""} style="width: 18px; height: 18px;"> Other Devices Coming Soon
            </label>
          </div>
        </div>
        <!-- Action Buttons -->
        <br>
        <button id="submit-button" style="display: none; margin-top: 10px; padding: 10px 15px; font-size: 14px; background: #28A745; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Connect</button>
        <button id="cancel-button" style="margin-top: 10px; padding: 10px 15px; font-size: 14px; background: gray; color: #fff; border: none; border-radius: 4px; cursor: pointer;">Cancel</button>
      </div>
    `;

            const dialogContainer = document.createElement("div");
            dialogContainer.innerHTML = dialogHTML;
            document.body.appendChild(dialogContainer);

            const ipInput = document.getElementById("ip-input");
            const networkOptions = document.getElementById("network-options");
            const submitButton = document.getElementById("submit-button");
            const testIpButton = document.getElementById("test-ip-button");
            // Event: USB HID
            document.getElementById("usb-hid-button").addEventListener("click", () => {
              document.body.removeChild(dialogContainer);
              resolve({ connectionType: "usb" });
            });

            // Event: USB Serial
            document.getElementById("usb-serial-button").addEventListener("click", () => {
              document.body.removeChild(dialogContainer);
              resolve({ connectionType: "serial" });
            });

            // Event: Network
            document.getElementById("network-button").addEventListener("click", () => {
              ipInput.style.display = "block";
              networkOptions.style.display = "block";
              submitButton.style.display = "inline-block";
            });

            // Watch for IP input to show the Test IP button
            ipInput.addEventListener("input", () => {
              const ip = ipInput.value.trim();
              const isValid = /^(\d{1,3}\.){3}\d{1,3}$/.test(ip); // basic IPv4 validation
              testIpButton.style.display = isValid ? "inline-block" : "none";
              submitButton.style.display = isValid ? "inline-block" : "none";
            });

            // Handle Test IP Button Click
            testIpButton.addEventListener("click", () => {
              const ip = ipInput.value.trim();
              if (!ip) return;
              const confirmProceed = confirm(`This will open a new tab to https://${ip}.\nIf your browser shows a page with some information you have already accepted the certificate, if is shows a security warning, typically "ERR_CERT_AUTHORITY_INVALID" then you will need to accept this cerificate to continue. \n\n You should examine this certificate, check that it is issued by LinkpLay and then used the "Advanced" button to accept this self-signed certificate to proceed with secure access. If this is successful you should see a page with technical information`);
              if (confirmProceed) {
                window.open(`https://${ip}/httpapi.asp?command=getStatusEx`, "_blank", "noopener,noreferrer");
              }
            });

            // Submit Network
            submitButton.addEventListener("click", () => {
              const ip = ipInput.value.trim();
              if (!ip) {
                showToast("Please enter a valid IP address.", "error");
                return;
              }

              const selectedDevice = document.querySelector('input[name="network-device"]:checked')?.value || "WiiM";
              document.body.removeChild(dialogContainer);
              resolve({ connectionType: "network", ipAddress: ip, deviceType: selectedDevice });
            });

            // Cancel
            document.getElementById("cancel-button").addEventListener("click", () => {
              document.body.removeChild(dialogContainer);
              resolve({connectionType: "none"});
            });
          });
        }


        // Disconnect Button Event Listener
        deviceEqUI.disconnectButton.addEventListener('click', async () => {
          try {
            if (deviceEqUI.connectionType == "network") {
              await NetworkDeviceConnector.disconnectDevice();
            } else if (deviceEqUI.connectionType == "usb")  {
              await UsbHIDConnector.disconnectDevice();
            } else if (deviceEqUI.connectionType == "serial")  {
              await UsbSerialConnector.disconnectDevice();
            }
            deviceEqUI.showDisconnectedState();
            // Emit custom event for device disconnection
            const event = new CustomEvent('devicePEQ.deviceDisconnected', { detail: { connectionType: deviceEqUI.connectionType } });
            window.dispatchEvent(event);
          } catch (error) {
            console.error("Error disconnecting:", error);
            showToast("Failed to disconnect.", "error");
          }
        });

        // Pull Button Event Listener
        deviceEqUI.pullButton.addEventListener('click', async () => {
          try {
            const device = deviceEqUI.currentDevice;
            const selectedSlot = deviceEqUI.peqDropdown.value;
            if (!device || !selectedSlot) {
              showToast("临时模式无法注入", "error");
              return;
            }
            var result = null;
            if (deviceEqUI.connectionType == "network") {
              result = await NetworkDeviceConnector.pullFromDevice(device, selectedSlot);
            } else if (deviceEqUI.connectionType == "usb") {
              result = await UsbHIDConnector.pullFromDevice(device, selectedSlot);
            } else if (deviceEqUI.connectionType == "serial") {
              result = await UsbSerialConnector.pullFromDevice(device, selectedSlot);
            }

            // Check if we have a timeout but still received some filters
            if (result.filters.length > 0) {
              // Normal case - all filters received
              deviceEqUI.suppressAutoPushUntil = Date.now() + 1200;
              deviceEqUI.lastAutoPushSignature = "";
              context.filtersToElem(result.filters);
              context.applyEQ();
              showToast("PEQ filters successfully pulled from device.", "success");
              setStatusText("已从设备读取 PEQ，并同步到当前页面。");
            } else {
              showToast("No PEQ filters found on the device.", "warning");
            }
          } catch (error) {
            console.error("Error pulling PEQ filters:", error);
            showToast("Failed to pull PEQ filters from device.", "error");

            if (deviceEqUI.connectionType == "network") {
              await NetworkDeviceConnector.disconnectDevice();
            } else if (deviceEqUI.connectionType == "usb") {
              await UsbHIDConnector.disconnectDevice();
            } else if (deviceEqUI.connectionType == "serial") {
              await UsbSerialConnector.disconnectDevice();
            }
            deviceEqUI.showDisconnectedState();
          }
        });

        // Push Button Event Listener
        deviceEqUI.pushButton.addEventListener('click', async () => {
          await pushCurrentFilters({ silent: false, source: "manual" });
        });

        // PEQ Dropdown Change Event Listener
        deviceEqUI.peqDropdown.addEventListener('change', async (event) => {
          const selectedValue = event.target.value;
          console.log(`PEQ Slot selected: ${selectedValue}`);
          deviceEqUI.lastAutoPushSignature = "";

          try {
            if (selectedValue === "-1") {
              if (deviceEqUI.connectionType == "network") {
                await NetworkDeviceConnector.enablePEQ(deviceEqUI.currentDevice, false, -1);
              } else if (deviceEqUI.connectionType == "usb") {
                await UsbHIDConnector.enablePEQ(deviceEqUI.currentDevice, false, -1);
              } else if (deviceEqUI.connectionType == "serial") {
                await UsbSerialConnector.enablePEQ(deviceEqUI.currentDevice, false, -1);
              }
              console.log("PEQ Disabled.");
            } else {
              const slotId = parseInt(selectedValue, 10);

              if (deviceEqUI.connectionType == "network") {
                await NetworkDeviceConnector.enablePEQ(deviceEqUI.currentDevice, true, slotId);
              } else if (deviceEqUI.connectionType == "usb") {
                await UsbHIDConnector.enablePEQ(deviceEqUI.currentDevice, true, slotId);
              } else if (deviceEqUI.connectionType == "serial") {
                await UsbSerialConnector.enablePEQ(deviceEqUI.currentDevice, true, slotId);
              }

              console.log(`PEQ Enabled for slot ID: ${slotId}`);
              scheduleRealtimePush("slot-changed");
            }
          } catch (error) {
            console.error("Error updating PEQ slot:", error);
            showToast("Failed to update PEQ slot.", "error");
          }
        });

      }
    }
  } catch (error) {
    console.  error("Error initializing Device EQ Plugin:", error.message);
  }
}
  return initializeDeviceEqPlugin;
})();

  Object.assign(window.DevicePeqBundle, {
    fiioUsbHID,
    walkplayUsbHID,
    moondropUsbHidHandler,
    ktmicroUsbHidHandler,
    qudelixUsbHidHandler,
    toppingUsbHidHandler,
    jdsLabsUsbSerial,
    nothingUsbSerial,
    fiioUsbSerial,
    wiimNetworkHandler,
    usbHidDeviceHandlerConfig,
    usbSerialDeviceHandlerConfig,
    UsbHIDConnector,
    UsbSerialConnector,
    NetworkDeviceConnector,
    initializeDeviceEqPlugin
  });

  window.initializeDeviceEqPlugin = initializeDeviceEqPlugin;
})();
