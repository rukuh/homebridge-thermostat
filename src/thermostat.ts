import ds18b20 from 'ds18b20';
import { Characteristic as CharacteristicClass, Service as ServiceClass } from 'hap-nodejs';
import * as Types from 'homebridge';
import redis from 'redis';
import { promisify } from 'util';
const gpiop = require('rpi-gpio').promise;
const ds18b20p = promisify(ds18b20.sensors);
const packageJson = require('../package.json')

let Characteristic: typeof CharacteristicClass, Service: typeof ServiceClass;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (homebridge: Types.API) => {
  Characteristic = homebridge.hap.Characteristic;
  Service = homebridge.hap.Service;
  homebridge.registerAccessory('hoembridge-web-thermostat', 'Thermostat', Thermostat);
};

class Thermostat implements Types.AccessoryPlugin {
  private readonly log: Types.Logging;

  private readonly informationService: Types.Service;
  private readonly thermostatService: Types.Service;

  private client: redis.RedisClient;
  private sensorID: string | undefined;
  private state: { [key: string]: Types.CharacteristicValue; }
  private threshold: number = 1.5;

  constructor(log: Types.Logging, config: Types.AccessoryConfig) {
    this.log = log;
    
    this.client = redis.createClient();

    this.state = {
      CurrentHeatingCoolingState: 0,
      TargetHeatingCoolingState: 0,
      CurrentTemperature: 25,
      TargetTemperature: 25,
      TemperatureDisplayUnits: Characteristic.TemperatureDisplayUnits.FAHRENHEIT,
    };

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
    this.thermostatService.getCharacteristic(Characteristic.TargetHeatingCoolingState)
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.CurrentTemperature)
      .on(Types.CharacteristicEventTypes.CHANGE, this.handleCurrentTemperatureChange.bind(this))  
      .onGet(this.handleCurrentTemperatureGet.bind(this));
      

    this.thermostatService.getCharacteristic(Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService.getCharacteristic(Characteristic.TemperatureDisplayUnits)
      .updateValue(this.state.TemperatureDisplayUnits);

    // setup a channel for use as an output
    gpiop.setup(13, gpiop.DIR_OUT);

    // get all connected sensor IDs as array
    ds18b20.sensors((err, ids) => this.sensorID = ids[0]);

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
      this.log.debug('State', this.state);

      this.state.CurrentTemperature = ds18b20.temperatureSync(this.sensorID);

      // push the new value to HomeKit
      this.thermostatService.updateCharacteristic(Characteristic.CurrentTemperature, this.state.CurrentTemperature);
    }, 10000);
  }

  getServices(): Types.Service[] {
    this.client.get('State', (err, state) => {
      if (state) {
        this.state = JSON.parse(state);
      }
    });

    return [
      this.informationService,
      this.thermostatService,
    ];
  }

  /**
   * Handle requests to set the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: Types.CharacteristicValue) {
    this.log.debug(this.handleTargetHeatingCoolingStateSet.name, value);
    
    this.state.CurrentHeatingCoolingState = value;
    this.state.TargetHeatingCoolingState = value;
    this.client.set('State', JSON.stringify(this.state));
    this.thermostatService.getCharacteristic(Characteristic.CurrentHeatingCoolingState).updateValue(value);
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
  async handleCurrentTemperatureChange(change: Types.CharacteristicChange) {
    this.log.debug(this.handleCurrentTemperatureChange.name, change.newValue);

    switch (this.state.TargetHeatingCoolingState) {
      case 0: // Off
        if (await gpiop.read(13)) {
          gpiop.write(13, false);
        }
        break;
      case 1: // Heat
        if (await gpiop.read(13) && this.state.CurrentTemperature > this.state.TargetTemperature) {
          gpiop.write(13, false);
        } else if ((this.state.TargetTemperature as number) - (this.state.CurrentTemperature as number) >= this.threshold * ( 5 / 9 )) {
          gpiop.write(13, true);
        }
        break;
      case 2: // Cool
        if (await gpiop.read(13) && this.state.CurrentTemperature < this.state.TargetTemperature) {
          gpiop.write(13, false);
        } else if ((this.state.CurrentTemperature as number) - (this.state.TargetTemperature as number) >= this.threshold * ( 5 / 9)) {
          gpiop.write(13, true);
        }
        break;
      default: // Auto
        this.log.debug('\'Auto\' mode is not supported for this device.');
        break;
    }
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

    this.state.TargetTemperature = value;
    this.client.set('State', JSON.stringify(this.state));
  }
}
