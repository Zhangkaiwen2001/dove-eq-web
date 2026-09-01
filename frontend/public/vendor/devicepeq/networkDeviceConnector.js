// networkDeviceConnector.js
// Copyright 2024 : Pragmatic Audio

const {wiimNetworkHandler} = await import('./wiimNetworkHandler.js');

export const NetworkDeviceConnector = (function () {
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

