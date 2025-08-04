import ds18b20 from 'ds18b20';
import { type CharacteristicChange, type CharacteristicValue, type PlatformAccessory, type Service } from 'homebridge';
import moment from 'moment';
import { createClient } from 'redis';
import * as request from 'request';
import { promisify } from 'util';
import type { RaspberryPi } from './platform';
const _ = require('lodash');
const packageJson = require('../package.json');
const rpio = require('rpio');
promisify(ds18b20.sensors);

interface AuthResponse {
  access_token: string;
  token_type: string;
  expires_in: number;
}

interface State {
  // coolingThresholdTemperature: CharacteristicValue;
  currentTemperature: CharacteristicValue;
  // heatingThresholdTemperature?: CharacteristicValue;
  lastOff: string;
  targetHeatingCoolingState: CharacteristicValue;
  targetTemperature: CharacteristicValue;
  temperatureDisplayUnits: CharacteristicValue;
}

/**
 * Platform Accessory
 * An instance of this class is created for each accessory your platform registers
 * Each accessory may expose multiple services of different service types.
 */
export class Thermostat {
  private service: Service;

  private state: State = {
    // coolingThresholdTemperature: 25,
    currentTemperature: 25,
    // heatingThresholdTemperature: 25,
    lastOff: moment('0000-01-01T00:00:00', moment.ISO_8601).format(),
    targetHeatingCoolingState: 0,
    targetTemperature: 25,
    temperatureDisplayUnits: 0
  };

  private authorization?: AuthResponse;
  private baseUrl = process.env.BASE_URL;
  private client = createClient();
  private pin = parseInt(process.env.PIN || '1');
  private sensorID?: string;
  private serialNumbers = process.env.SERIAL_NUMBERS?.split(',') || [];
  private tempStep?: number;

  constructor(
    private readonly platform: RaspberryPi,
    private readonly accessory: PlatformAccessory,
  ) {
    this.client.connect().then(() => {
      this.getAuthorization();
      this.getState();
    });

    // set accessory information
    this.accessory.getService(this.platform.Service.AccessoryInformation)!
      .setCharacteristic(this.platform.Characteristic.FirmwareRevision, packageJson.version || '1.0')
      .setCharacteristic(this.platform.Characteristic.Manufacturer, packageJson.author.name || 'Unknown')
      .setCharacteristic(this.platform.Characteristic.Model, 'Raspberry Pi')
      .setCharacteristic(this.platform.Characteristic.SerialNumber, 'None');

    // get the LightBulb service if it exists, otherwise create a new LightBulb service
    // you can create multiple services for each accessory
    this.service = this.accessory.getService(this.platform.Service.Thermostat) || this.accessory.addService(this.platform.Service.Thermostat);

    // set the service name, this is what is displayed as the default name on the Home app
    // in this example we are using the name we stored in the `accessory.context` in the `discoverDevices` method.
    this.service.setCharacteristic(this.platform.Characteristic.Name, accessory.context.device.displayName);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // register handlers for the TemperatureDisplayUnits Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits)
      .onSet(this.setTemperatureDisplayUnits.bind(this))
      .onGet(this.getTemperatureDisplayUnits.bind(this));

    // setup a channel for use as an output
    this.openPin(this.pin);

    // register handlers for the CurrentTemperature Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .on('change', this.handleCurrentTemperature.bind(this))
      .onGet(this.getCurrentTemperature.bind(this));

    // register handlers for the CurrentHeatingCoolingState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.getCurrentHeatingCoolingState.bind(this));

    /*
    * Only allow 0.5 increments for Celsius temperatures. HomeKit is already limited to 1-degree increments in Fahrenheit,
    * and setting this value for Fahrenheit will cause HomeKit to incorrectly round values when converting from °F to °C and back.
    */
    this.setProps();

    // register handlers for the TargetTemperature Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .onSet(this.setTargetTemperature.bind(this))
      .onGet(this.getTargetTemperature.bind(this));

    // register handlers for the TargetHeatingCoolingState Characteristic
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .onSet(this.setTargetHeatingCoolingState.bind(this))
      .onGet(this.getTargetHeatingCoolingState.bind(this));

    // register handlers for the CoolingThresholdTemperature Characteristic
    // this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
    //   .onSet(this.setCoolingThresholdTemperature.bind(this))
    //   .onGet(this.getCoolingThresholdTemperature.bind(this));

    // register handlers for the HeatingThresholdTemperature Characteristic
    // this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
    //   .onSet(this.setHeatingThresholdTemperature.bind(this))
    //   .onGet(this.getHeatingThresholdTemperature.bind(this));

    // get sensor ID
    this.getSensors();

    /**
     * Updating characteristics values asynchronously.
     *
     * Example showing how to update the state of a Characteristic asynchronously instead
     * of using the `on('get')` handlers.
     * Here we change update the motion sensor trigger states on and off every 10 seconds
     * the `updateCharacteristic` method.
     *
     */
    setInterval(() => {
      try {
        // read sensor temperature and set state
        this.setState({ currentTemperature: _.mean([...this.getRemoteTemperatures(), ds18b20.temperatureSync(this.sensorID)]) });

        // push the new value to HomeKit
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
      } catch (e) {
        let message;

        if (typeof e === 'string') {
          message = e.toUpperCase();
        } else if (e instanceof Error) {
          message = e.message; // works, `e` narrowed to Error
        }

        this.platform.log(message);
      }

      this.platform.log.info('Thermostat state', {
        // coolingThresholdTemperature: this.formatAsDisplayTemperature(this.state.coolingThresholdTemperature),
        currentHeatingCoolingState: this.formatCurrentHeatingCoolingState(this.getCurrentHeatingCoolingStateSync()),
        currentTemperature: this.formatAsDisplayTemperature(this.state.currentTemperature),
        // heatingThresholdTemperature: this.formatAsDisplayTemperature(this.state.heatingThresholdTemperature),
        lastOff: this.state.lastOff,
        targetHeatingCoolingState: this.formatTargetHeatingCoolingState(this.state.targetHeatingCoolingState),
        targetTemperature: this.formatAsDisplayTemperature(this.state.targetTemperature),
        temperatureDisplayUnits: this.formatTemperatureDisplayUnits(this.state.temperatureDisplayUnits)
      });
    }, 30000);
  }

  /**
   * Handle the "GET" requests from HomeKit
   * These are sent when HomeKit wants to know the current state of the accessory, for example, checking if a Light bulb is on.
   *
   * GET requests should return as fast as possible. A long delay here will result in
   * HomeKit being unresponsive and a bad user experience in general.
   *
   * If your device takes time to respond you should update the status of your device
   * asynchronously instead using the `updateCharacteristic` method instead.
   * In this case, you may decide not to implement `onGet` handlers, which may speed up
   * the responsiveness of your device in the Home app.

   * @example
   * this.service.updateCharacteristic(this.platform.Characteristic.On, true)
   */
  // async getCoolingThresholdTemperature(): Promise<CharacteristicValue> {
  //   this.platform.log.debug(this.getCoolingThresholdTemperature.name, this.formatAsDisplayTemperature(this.state.coolingThresholdTemperature));

  //   return this.unroundTemperature(this.state.coolingThresholdTemperature);
  // }

  async getCurrentHeatingCoolingState(): Promise<CharacteristicValue> {
    const getPin = this.readPin(this.pin);
    let currentHeatingCoolingState;

    switch (getPin) {
      case rpio.LOW:
        currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
      case rpio.HIGH:
        switch (this.state.targetHeatingCoolingState) {
          case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
            currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
            break;
          case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
            currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
            break;
        }
    }

    this.platform.log.debug(this.getCurrentHeatingCoolingState.name, this.formatCurrentHeatingCoolingState(currentHeatingCoolingState));

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return currentHeatingCoolingState;
  }

  getCurrentHeatingCoolingStateSync(): CharacteristicValue {
    const getPin = this.readPin(this.pin);
    let currentHeatingCoolingState;

    switch (getPin) {
      case rpio.LOW:
        currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.OFF;
        break;
      case rpio.HIGH:
        switch (this.state.targetHeatingCoolingState) {
          case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
            currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.HEAT;
            break;
          case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
            currentHeatingCoolingState = this.platform.Characteristic.CurrentHeatingCoolingState.COOL;
            break;
        }
    }

    this.platform.log.debug(this.getCurrentHeatingCoolingState.name, this.formatCurrentHeatingCoolingState(currentHeatingCoolingState));

    // if you need to return an error to show the device as "Not Responding" in the Home app:
    // throw new this.platform.api.hap.HapStatusError(this.platform.api.hap.HAPStatus.SERVICE_COMMUNICATION_FAILURE);

    return currentHeatingCoolingState;
  }

  async getCurrentTemperature(): Promise<CharacteristicValue> {
    this.platform.log.debug(this.getCurrentTemperature.name, this.formatAsDisplayTemperature(this.state.currentTemperature));

    return this.unroundTemperature(this.state.currentTemperature);
  }

  // async getHeatingThresholdTemperature(): Promise<CharacteristicValue> {
  //   this.platform.log.debug(this.getHeatingThresholdTemperature.name, this.formatAsDisplayTemperature(this.state.heatingThresholdTemperature));

  //   return this.unroundTemperature(this.state.heatingThresholdTemperature);
  // }

  async getTargetHeatingCoolingState(): Promise<CharacteristicValue> {
    this.platform.log.debug(this.getTargetHeatingCoolingState.name, this.formatTargetHeatingCoolingState(this.state.targetHeatingCoolingState));

    return this.state.targetHeatingCoolingState;
  }

  async getTargetTemperature(): Promise<CharacteristicValue> {
    this.platform.log.debug(this.getTargetTemperature.name, this.formatAsDisplayTemperature(this.state.targetTemperature));

    switch (await this.getTargetHeatingCoolingState()) {
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        return this.getCurrentTemperature();
      default:
        return this.unroundTemperature(this.state.targetTemperature);
    }
  }

  async getTemperatureDisplayUnits(): Promise<CharacteristicValue> {
    this.platform.log.debug(this.getTemperatureDisplayUnits.name, this.formatTemperatureDisplayUnits(this.state.temperatureDisplayUnits));

    return this.state.temperatureDisplayUnits;
  }

  /**
   * Handle "SET" requests from HomeKit
   * These are sent when the user changes the state of an accessory, for example, changing the Brightness
   */
  // async setCoolingThresholdTemperature(value: CharacteristicValue) {
  //   this.platform.log.debug(this.setCoolingThresholdTemperature.name, this.formatAsDisplayTemperature(value));

  //   this.setState({ CoolingThresholdTemperature: value });
  // }

  // async setHeatingThresholdTemperature(value: CharacteristicValue) {
  //   this.platform.log.debug(this.setHeatingThresholdTemperature.name, this.formatAsDisplayTemperature(value));

  //   this.setState({ HeatingThresholdTemperature: value });
  // }

  async setTargetHeatingCoolingState(value: CharacteristicValue) {
    this.platform.log.debug(this.setTargetHeatingCoolingState.name, this.formatTargetHeatingCoolingState(value));

    this.setState({ targetHeatingCoolingState: value });
  }

  async setTargetTemperature(value: CharacteristicValue) {
    this.platform.log.debug(this.setTargetTemperature.name, this.formatAsDisplayTemperature(this.state.targetTemperature));

    this.setState({ targetTemperature: value });
  }

  async setTemperatureDisplayUnits(value: CharacteristicValue) {
    this.setState({ temperatureDisplayUnits: value });

    this.platform.log.debug(this.setTemperatureDisplayUnits.name, this.formatTemperatureDisplayUnits(value));
  }

  async handleCurrentTemperature(change: CharacteristicChange) {
    this.platform.log.debug(this.handleCurrentTemperature.name, this.formatAsDisplayTemperature(change.newValue));

    const currentTemperature = change.newValue as number;
    const targetTemperature = this.state.targetTemperature as number;

    const getPin = this.readPin(this.pin);
    let setPin;

    switch (this.state.targetHeatingCoolingState) {
      case 0: // Off
        if (getPin === rpio.HIGH) {
          setPin = rpio.LOW;
        }
        break;
      case 1: // Heating
        if (getPin === rpio.HIGH && (currentTemperature - targetTemperature) >= (3 * 5/9)) {
          setPin = rpio.LOW;
        } else if (targetTemperature - currentTemperature >= (1 * 5/9) && !this.compressorDelay()) {
          setPin = rpio.HIGH;
        }
        break;
      case 2: // Cooling
        if (getPin === rpio.HIGH && targetTemperature - currentTemperature >= (2 * 5/9)) {
          setPin = rpio.LOW;
        } else if (currentTemperature - targetTemperature >= (1 * 5/9) && !this.compressorDelay()) {
          setPin = rpio.HIGH;
        }
        break;
      default: // Auto
        this.platform.log.debug('\'Auto\' mode is not supported for this device.');
        break;
    }

    if (setPin !== undefined) {
      this.writePin(this.pin, setPin);
    }

    this.setState({
      lastOff: setPin === rpio.LOW ? moment().format() : this.state.lastOff
    });
  }

  celsiusToFahrenheit(temperature: number) {
    return (temperature * 1.8) + 32;
  }

  compressorDelay() {
    const fourMinutesAgo = moment().subtract(4, 'minutes');

    return moment(this.state.lastOff).isAfter(fourMinutesAgo);
  }

  fahrenheitToCelsius(temperature) {
    return (temperature - 32) / 1.8;
  }

  formatAsDisplayTemperature(value: CharacteristicValue | null) {
    const t = value as number;
    const precision = 0.001;

    return (precision * Math.round(t / precision)) + ' °C / ' + (precision * Math.round(this.celsiusToFahrenheit(t) / precision)) + ' °F';
  }

  formatCurrentHeatingCoolingState(value: CharacteristicValue) {
    switch (value) {
      case this.platform.Characteristic.CurrentHeatingCoolingState.OFF:
        return 'Off';
      case this.platform.Characteristic.CurrentHeatingCoolingState.HEAT:
        return 'Heating';
      case this.platform.Characteristic.CurrentHeatingCoolingState.COOL:
        return 'Cooling';
    }
  }

  formatTargetHeatingCoolingState(value: CharacteristicValue) {
    switch (value) {
      case this.platform.Characteristic.TargetHeatingCoolingState.OFF:
        return 'Off';
      case this.platform.Characteristic.TargetHeatingCoolingState.HEAT:
        return 'Heat';
      case this.platform.Characteristic.TargetHeatingCoolingState.COOL:
        return 'Cool';
      case this.platform.Characteristic.TargetHeatingCoolingState.AUTO:
        return 'Auto';
    }
  }

  formatTemperatureDisplayUnits(value: CharacteristicValue) {
    return value === this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT ? 'Fahrenheit' : 'Celsius';
  }

  getAuthorization() {
    this.client.get('Authorization').then((authorization: string | null) => {
      if (authorization) {
        this.authorization = JSON.parse(authorization);
      } else {
        request.post({ url: `${this.baseUrl}/api/auth/noauth` }, (err, res, body) => {
          if (err) {
            return this.platform.log.error(err);
          }
          this.platform.log.debug(`Status: ${res.statusCode}`, body);
          this.authorization = JSON.parse(body);
          this.client.set('Authorization', body, { EX: this.authorization?.expires_in });
        });
      }
    });
  }

  getRemoteTemperatures() {
    const remoteTemperatures: string[] = [];

    const options = {
      url: `${this.baseUrl}/api/accessories`,
      auth: { bearer: this.authorization?.access_token }
    };

    request.get(options, (err, res, body) => {
      if (err) {
        this.platform.log.error(err);
      }

      for (const accessory of JSON.parse(body)) {
        if (this.serialNumbers.includes(accessory.accessoryInformation['Serial Number'])) {
          remoteTemperatures.push(accessory.values.CurrentTemperature);
        }
      }

      this.platform.log.debug(this.getRemoteTemperatures.name, remoteTemperatures);
    });

    return remoteTemperatures;
  }

  getSensors() {
    ds18b20.sensors((err: Error, ids: string[]) => {
      if (err) {
        this.platform.log.error(err.message);
      }
      this.sensorID = ids[0];

    });
  }

  getState() {
    this.client.get('State').then((state: string | null) => {
      if (state) {
        this.platform.log.debug('redisState', state);
        this.setState(JSON.parse(state));
        // this.service.updateCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature, this.state.coolingThresholdTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.CurrentTemperature, this.state.currentTemperature);
        // this.service.updateCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature, this.state.heatingThresholdTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState, this.state.targetHeatingCoolingState);
        this.service.updateCharacteristic(this.platform.Characteristic.TargetTemperature, this.state.targetTemperature);
        this.service.updateCharacteristic(this.platform.Characteristic.TemperatureDisplayUnits, this.state.temperatureDisplayUnits);
      }
    });
  }

  openPin(pin: number) {
    rpio.open(pin, rpio.OUTPUT);
    this.platform.log.debug(`Pin ${pin} is currently ${rpio.read(pin) ? 'high' : 'low'}`);
  }

  readPin(pin: number) {
    const rPin = rpio.read(pin);
    this.platform.log.debug(`Read pin ${pin}, value is ${rPin ? 'high' : 'low'}`);

    return rPin;
  }

  writePin(pin: number, value: number) {
    rpio.write(pin, value);
    this.platform.log.debug(`Write pin ${pin}, set to ${value ? 'high' : 'low'}`);
  }

  async setProps() {
    let minSetTemp, maxSetTemp, minGetTemp, maxGetTemp;
    if (await this.usesFahrenheit()) {
      minSetTemp = this.fahrenheitToCelsius(50);
      maxSetTemp = this.fahrenheitToCelsius(90);
      minGetTemp = this.fahrenheitToCelsius(0);
      maxGetTemp = this.fahrenheitToCelsius(160);
    } else {
      minSetTemp = 9;
      maxSetTemp = 32;
      minGetTemp = -20;
      maxGetTemp = 60;
    }

    this.service.getCharacteristic(this.platform.Characteristic.CurrentTemperature)
      .setProps({ minStep: this.tempStep, minValue: minGetTemp, maxValue: maxGetTemp });
    this.service.getCharacteristic(this.platform.Characteristic.TargetTemperature)
      .setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });
    // this.service.getCharacteristic(this.platform.Characteristic.CoolingThresholdTemperature)
    //   .setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });
    // this.service.getCharacteristic(this.platform.Characteristic.HeatingThresholdTemperature)
    //   .setProps({ minStep: this.tempStep, minValue: minSetTemp, maxValue: maxSetTemp });
    this.service.getCharacteristic(this.platform.Characteristic.TargetHeatingCoolingState)
      .setProps({ validValues: [ this.platform.Characteristic.TargetHeatingCoolingState.OFF, this.platform.Characteristic.TargetHeatingCoolingState.HEAT, this.platform.Characteristic.TargetHeatingCoolingState.COOL ]});
  }

  setState(state: Partial<State>) {
    this.state = { ...this.state, ...state };
    try {
      this.client.set('State', JSON.stringify(this.state));
    } catch(e) {
      this.platform.log.error('Redis write error', e);
    }
  }

  async unroundTemperature(value: CharacteristicValue) {
    const temperature = value as number;
    if (this.usesFahrenheit && await this.usesFahrenheit()) {
      // Uses deg F? Round to nearest degree in F.
      const tempF = Math.round(this.celsiusToFahrenheit(temperature));
      return this.fahrenheitToCelsius(tempF);
    } else if (this.usesFahrenheit && !this.usesFahrenheit()) {
      // Uses deg C? Round to nearest half degree in C.
      const tempC = 0.5 * Math.round(2 * temperature);
      return tempC;
    } else {
      return temperature;
    }
  }

  async usesFahrenheit() {
    return await this.getTemperatureDisplayUnits() === this.platform.Characteristic.TemperatureDisplayUnits.FAHRENHEIT;
  }
}
