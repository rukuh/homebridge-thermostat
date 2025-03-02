import ds18b20 from 'ds18b20';
import { Characteristic as CharacteristicClass, Service as ServiceClass } from 'hap-nodejs';
import * as Types from 'homebridge';
import moment, { Moment } from 'moment';
import redis from 'redis';
import { promisify } from 'util';
const packageJson = require('../package.json');
const rpio = require('rpio');
promisify(ds18b20.sensors);

let Characteristic: typeof CharacteristicClass, Service: typeof ServiceClass;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (homebridge: Types.API) => {
  Characteristic = homebridge.hap.Characteristic;
  Service = homebridge.hap.Service;
  homebridge.registerAccessory('homebridge-thermostat', 'Thermostat', Thermostat);
};

interface State {
  [key: string]: Types.CharacteristicValue;
}

class Thermostat implements Types.AccessoryPlugin {
  private readonly log: Types.Logging;

  private readonly informationService: Types.Service;
  private readonly thermostatService: Types.Service;

  private client: redis.RedisClient;
  private lastOff: Moment = moment('0000-01-01', 'YYYY-MM-DD');
  private pin = parseInt(process.env.PIN || '1');
  private rpio: any;
  private sensorID: string | undefined;
  private state: State;

  constructor(log: Types.Logging, config: Types.AccessoryConfig) {
    this.log = log;

    this.client = redis.createClient();

    this.state = {
      CurrentHeatingCoolingState: 0,
      CurrentTemperature: 25,
      TargetHeatingCoolingState: 0,
      TargetTemperature: 25,
      TemperatureDisplayUnits: 1,
    };

    this.client.get('State', this.updateValues.bind(this));

    // set accessory information
    this.informationService = new Service.AccessoryInformation()
      .setCharacteristic(Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(Characteristic.Model, 'Default-Model')
      .setCharacteristic(Characteristic.SerialNumber, 'Default-Serial')
      .setCharacteristic(Characteristic.FirmwareRevision, packageJson.version);

    // get the Thermostat service if it exists, otherwise create a new Thermostat service
    // you can create multiple services for each accessory
    this.thermostatService = new Service.Thermostat(config.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // create handlers for required characteristics
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .on(Types.CharacteristicEventTypes.CHANGE, this.handleCurrentTemperatureChange.bind(this))
      .onGet(this.handleCurrentTemperatureGet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    // setup a channel for use as an output
    rpio.open(this.pin, rpio.OUTPUT);
    this.log.debug(`Pin ${this.pin} is currently ` + (rpio.read(this.pin) ? 'high' : 'low'));

    // get all connected sensor IDs as array
    ds18b20.sensors((err, ids) => {
      if (err) {
        this.log.error(err);
      }
      this.sensorID = ids[0];
    });

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
      this.log.debug('State', { ...this.state, lastOff: this.lastOff.toString() });
      this.setState({ CurrentTemperature: ds18b20.temperatureSync(this.sensorID) });
      // push the new value to HomeKit
      this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, this.state.CurrentTemperature);
    }, 10000);
  }

  getServices(): Types.Service[] {
    return [
      this.informationService,
      this.thermostatService,
    ];
  }

  /**
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet() {
    this.log.debug(this.handleCurrentHeatingCoolingStateGet.name);

    return this.state.CurrentHeatingCoolingState;
  }

  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    this.log.debug(this.handleTargetHeatingCoolingStateGet.name);

    return this.state.TargetHeatingCoolingState;
  }

  /**
   * Handle requests to set the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: Types.CharacteristicValue) {
    this.log.debug(this.handleTargetHeatingCoolingStateSet.name, value);

    this.setState({ TargetHeatingCoolingState: value });

    // this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(value);
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.log.debug(this.handleCurrentTemperatureGet.name);

    return this.state.CurrentTemperature;
  }

  /**
   * Handle on change requests of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureChange(change: Types.CharacteristicChange) {
    this.log.debug(this.handleCurrentTemperatureChange.name, change.newValue);

    const pin = rpio.read(this.pin);

    switch (this.state.TargetHeatingCoolingState) {
      case 0: // Off
        if (pin) {
          rpio.write(this.pin, rpio.LOW);
          this.lastOff = moment();
        }
        break;
      case 1: // Heating
        if (typeof this.state.TargetTemperature === 'number' && typeof this.state.CurrentTemperature === 'number') {
          if (pin && (this.state.CurrentTemperature - this.state.TargetTemperature) >= (3 * 5/9)) {
            rpio.write(this.pin, rpio.LOW);
            this.lastOff = moment();
          } else if (this.state.TargetTemperature - this.state.CurrentTemperature >= (1 * 5/9) && !this.compressorDelay()) {
            rpio.write(this.pin, rpio.HIGH);
          }
        }
        break;
      case 2: // Cooling
        if (typeof this.state.TargetTemperature === 'number' && typeof this.state.CurrentTemperature === 'number') {
          if (pin && this.state.TargetTemperature - this.state.CurrentTemperature >= (2 * 5/9)) {
            rpio.write(this.pin, rpio.LOW);
            this.lastOff = moment();
          } else if (this.state.CurrentTemperature - this.state.TargetTemperature >= (1 * 5/9) && !this.compressorDelay()) {
            rpio.write(this.pin, rpio.HIGH);
          }
        }
        break;
      default: // Auto
        this.log.debug('\'Auto\' mode is not supported for this device.');
        break;
    }

    this.setState({ CurrentHeatingCoolingState: rpio.read(this.pin) ? 1 : 0 });
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    this.log.debug(this.handleTargetTemperatureGet.name);

    return this.state.TargetTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value: Types.CharacteristicValue) {
    this.log.debug(this.handleTargetTemperatureSet.name, value);

    this.setState({ TargetTemperature: value });
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    this.log.debug(this.handleTemperatureDisplayUnitsGet.name);

    return this.state.TemperatureDisplayUnits;
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value: Types.CharacteristicValue) {
    this.log.debug(this.handleTemperatureDisplayUnitsSet.name, value);

    this.setState({ TemperatureDisplayUnits: value });
  }

  compressorDelay() {
    const fourMinutesAgo = moment().subtract(4, 'minutes');
    return this.lastOff.isAfter(fourMinutesAgo);
  }

  setState(state: State) {
    this.state = {
      ...this.state,
      ...state,
    };

    try {
      this.client.set('State', JSON.stringify(this.state));
    } catch(e) {
      this.log.error('Redis write error', e);
    }
  }

  updateValues(err?: Error, redisState?: string) {
    this.log.debug('redisState', redisState);
    if (redisState) {
      this.state = JSON.parse(redisState);
      this.thermostatService.updateCharacteristic(Characteristic.CurrentHeatingCoolingState, this.state.CurrentHeatingCoolingState);
      this.thermostatService.updateCharacteristic(Characteristic.TargetHeatingCoolingState, this.state.TargetHeatingCoolingState);
      this.thermostatService.updateCharacteristic(Characteristic.TargetTemperature, this.state.TargetTemperature);
      this.thermostatService.updateCharacteristic(Characteristic.TemperatureDisplayUnits, this.state.TemperatureDisplayUnits);
    }
  }
}
