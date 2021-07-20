import ds18b20 from 'ds18b20';
import { AccessoryConfig, AccessoryPlugin, API, CharacteristicChange, CharacteristicValue, HAP, Logging, Service } from 'homebridge';
import redis from 'redis';
import gpio from 'rpi-gpio';

let hap: HAP;

/*
 * Initializer function called when the plugin is loaded.
 */
export = (api: API) => {
  hap = api.hap;
  api.registerAccessory('Thermostat', Thermostat);
};

class Thermostat implements AccessoryPlugin {
  private readonly log: Logging;
  private readonly name: string;

  private readonly informationService: Service;
  private readonly thermostatService: Service;

  private client: redis.RedisClient;
  private sensorID;
  private threshold = 1.5;

  private state = {
    CurrentHeatingCoolingState: 0,
    TargetHeatingCoolingState: 0,
    CurrentTemperature: 25,
    TargetTemperature: 25,
    TemperatureDisplayUnits: hap.Characteristic.TemperatureDisplayUnits.CELSIUS,
  };

  constructor(log: Logging, config: AccessoryConfig) {
    this.log = log;
    this.name = config.name;

    this.client = redis.createClient();

    // set accessory information
    this.informationService = new hap.Service.AccessoryInformation()
      .setCharacteristic(hap.Characteristic.Manufacturer, 'Default-Manufacturer')
      .setCharacteristic(hap.Characteristic.Model, 'Default-Model')
      .setCharacteristic(hap.Characteristic.SerialNumber, 'Default-Serial');

    // get the Thermostat service if it exists, otherwise create a new Thermostat service
    // you can create multiple services for each accessory
    this.thermostatService = new hap.Service.Thermostat(this.name);

    // each service must implement at-minimum the "required characteristics" for the given service type
    // see https://developers.homebridge.io/#/service/Lightbulb

    // create handlers for required characteristics
    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentHeatingCoolingState)
      .onGet(this.handleCurrentHeatingCoolingStateGet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetHeatingCoolingState)
      .onGet(this.handleTargetHeatingCoolingStateGet.bind(this))
      .onSet(this.handleTargetHeatingCoolingStateSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.CurrentTemperature)
      .onGet(this.handleCurrentTemperatureGet.bind(this))
      .on('change', this.handleCurrentTemperatureChange.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TargetTemperature)
      .onGet(this.handleTargetTemperatureGet.bind(this))
      .onSet(this.handleTargetTemperatureSet.bind(this));

    this.thermostatService.getCharacteristic(hap.Characteristic.TemperatureDisplayUnits)
      .onGet(this.handleTemperatureDisplayUnitsGet.bind(this))
      .onSet(this.handleTemperatureDisplayUnitsSet.bind(this));

    // set pin reference mode
    gpio.setMode(gpio.MODE_BCM);

    // setup a channel for use as an output
    gpio.setup(27, gpio.DIR_OUT);

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
      this.log.debug('State:', this.state);

      this.state.CurrentTemperature = ds18b20.temperatureSync(this.sensorID);

      // push the new value to HomeKit
      this.thermostatService.updateCharacteristic(hap.Characteristic.CurrentTemperature, this.state.CurrentTemperature);
    }, 10000);
  }

  getServices(): Service[] {
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
   * Handle requests to get the current value of the "Current Heating Cooling State" characteristic
   */
  handleCurrentHeatingCoolingStateGet() {
    this.log.debug('Triggered GET CurrentHeatingCoolingState');

    return this.state.CurrentHeatingCoolingState;
  }


  /**
   * Handle requests to get the current value of the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateGet() {
    this.log.debug('Triggered GET TargetHeatingCoolingState');

    return this.state.TargetHeatingCoolingState;
  }

  /**
   * Handle requests to set the "Target Heating Cooling State" characteristic
   */
  handleTargetHeatingCoolingStateSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TargetHeatingCoolingState:', value);

    this.state.TargetHeatingCoolingState = value as number;
    this.client.set('State', JSON.stringify(this.state));
  }

  /**
   * Handle requests to get the current value of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureGet() {
    this.log.debug('Triggered GET CurrentTemperature');

    return this.state.CurrentTemperature;
  }

  /**
   * Handle on change requests of the "Current Temperature" characteristic
   */
  handleCurrentTemperatureChange(change: CharacteristicChange) {
    this.log.debug('Triggered CHANGE CurrentTemperature:', change.newValue);

    switch (this.state.TargetHeatingCoolingState) {
      // Off
      case 0:
        gpio.input(27, (value) => {
          if (value) {
            gpio.output(27, false);
          }
        });
        break;
      // Heat
      case 1:
        gpio.input(27, (value) => {
          if (value && this.state.CurrentTemperature > this.state.TargetTemperature) {
            gpio.output(27, false);
          } else if (this.state.TargetTemperature - this.state.CurrentTemperature >= this.threshold * ( 5 / 9 )) {
            gpio.output(27, true);
          }
        });
        break;
      // Cool
      case 2:
        gpio.input(27, (value) => {
          if (value && this.state.CurrentTemperature < this.state.TargetTemperature) {
            gpio.output(27, false);
          } else if (this.state.CurrentTemperature - this.state.TargetTemperature >= this.threshold * ( 5 / 9)) {
            gpio.output(27, true);
          }
        });
        break;
      // Auto
      default:
        this.log.debug('\'Auto\' mode is not supported for this device.');
        break;
    }
  }

  /**
   * Handle requests to get the current value of the "Target Temperature" characteristic
   */
  handleTargetTemperatureGet() {
    this.log.debug('Triggered GET TargetTemperature');

    return this.state.TargetTemperature;
  }

  /**
   * Handle requests to set the "Target Temperature" characteristic
   */
  handleTargetTemperatureSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TargetTemperature:', value);

    this.state.TargetTemperature = value as number;
    this.client.set('State', JSON.stringify(this.state));
  }

  /**
   * Handle requests to get the current value of the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsGet() {
    this.log.debug('Triggered GET TemperatureDisplayUnits');

    return this.state.TemperatureDisplayUnits;
  }

  /**
   * Handle requests to set the "Temperature Display Units" characteristic
   */
  handleTemperatureDisplayUnitsSet(value: CharacteristicValue) {
    this.log.debug('Triggered SET TemperatureDisplayUnits:', value);

    this.state.TemperatureDisplayUnits = value as number;
    this.client.set('State', JSON.stringify(this.state));
  }
}
