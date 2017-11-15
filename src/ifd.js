/**
 * IFD Handler for Smart Card class reader
 *
 * - reader/CCID configuration of endpoints has to be done manually, see supportedReaders variable.
 * - init() has to be run. Not run automatically for custom error handling.
 * - limitation: only 1 active CCID/reader used exclusively in (this) one browser context (tab/window)
 *
 * TODO
 * - check if device is in use
 *
 * OPTIONAL
 * - support different reader revision configurations
 *
 * Copyright (C) 2017, Jan Birkholz <jbirkhol@informatik.hu-berlin.de>
 */

import * as util from "./util.js";
import * as ccid from "./ccid.js";

/**
 * Selected WebUSB Interface Device
 * @type {USBDevice}
 */
var Device;
/**
 * USB Smart Card Interfaces' descriptor data, containing class descriptor data.
 * @type {Array}
 */
var Interfaces;
/**
 * Active reader configuration. Eg {vendorId:0x04E6,productId:0x5790,configuration:1,interface:0,alternate:0,bulkOutEndpoint:1,bulkInEndpoint:2,descriptor:{USBDescriptor},device:{USBDevice}}
 * @type {Object}
 */
var Reader;


/**
 * Get first available USBDevice, which user consented on
 * @return {USBDevice} found USB device
 */
function getFirstUSBDevice() {
  return window.navigator.usb.getDevices().then((devices)=>{
    if(devices.length===0) throw new Error("No device found. A device has to be requested before it can be used.");
    if(devices.length > 1) throw new Error("Multiple devices found. Please connect only 1 requested device at once or disconnect other devices from your browser.");
    let device = devices[0];
    return device;
  });
}

/**
* User gesture triggered request dialog, followed by initialization of selected device.
* @returns {Promise<void>}
*/
function requestDevice (clickEvent) {
  if(clickEvent==null) throw new Error("User gesture required for requesting a device");
  return window.navigator.usb.requestDevice({filters:[]}).then(foundDevice=>{
    return init(foundDevice);
  });
}


/**
 * Transceive device configuration descriptor and parse it.
 * - non CCID device will throw error
 * @param  {USBDevice} device - targeted USB device
 * @return {Promise<Object>}        parsed ccid descriptor object
 */
function getConfigurationDescriptor(device) {
  //TODO: to support multiple configurations, controlTransfer has to be done for each configuration, defined by 2nd byte in 'value'
  let uSBControlTransferParametersOut = {
    //GET_DESCRIPTOR always uses bmRequestType 10000000B = requestType:"standard",recipient: "device"
    requestType: "standard",  //"standard","class","vendor"
    recipient: "device",      //"device","interface","endpoint","other"
    request: 0x06,            //0x06 GET_DESCRIPTOR
    value: 0x0200,            //descriptor type,descriptor index.
                              //Types:1:device,2:configuration,4:interface,5:endpoint.
                              //Word length, little endian order of bytes.
                              //Avoid decimals, because of different byte order.
    index: 0x0000             //zero or language id
  };


  //TODO: check if device is in an error state or reset it. No further selection required eg selectConfiguration
  return device.open().then(()=>{
    let transferInStatus = "none";
    let transferIn = () => {
      return device.controlTransferIn(uSBControlTransferParametersOut,4096).then(inResult=>{ //this controlTransfer is not a problem for future timeouts
          return ccid.parseConfigurationDescriptor(inResult.data.buffer);
      });
    };
    return transferIn();
  });
}

/**
 * Listen on given Interrupt-IN and debug log to console.
 * @param  {USBDevice} device   - USBDevice object
 * @param  {Number} endpoint  - desired Interrupt-IN endpoint. No checks done here.
 * @return {Promise}         returned promise after setting up listener.
 */
function listenInterrupt(device,endpoint) {
  //find interrupt endpoint
  //TODO set transferIn length to value from ccid class descriptor
  let ccidMaxMessageSize = Reader.descriptor.SmartCardClassDescriptor.dwMaxCCIDMessageLength;
  let receive = () => {
    return device.transferIn(endpoint,ccidMaxMessageSize).then(inResult=>{
      util.log("Interrupt-IN");
      util.log(inResult.data.buffer);
      return receive();
    });
  };
  return receive();
}

/**
 * Send message and receive answer.
 * - no chaining support
 * @param  {USBDevice} device
 * @param  {Number} endpointOut
 * @param  {Number} endpointIn
 * @param  {Object} message     - CCID message (including header)
 * @return {Promise<ArrayBuffer>} Promise resolving to reseived result
 */
function internalTransceive (device, endpointOut, endpointIn, message) {
  if(device===null) throw new Error("No device connected.");
  let ccidMaxMessageSize = Reader.descriptor.SmartCardClassDescriptor.dwMaxCCIDMessageLength;
  if(message.length>ccidMaxMessageSize) throw new Error("Message too large. Max length is "+ccidMaxMessageSize+"bytes."); //TODO: support CCID chunking. Check Reader?
  util.log("out: "+endpointOut+", in: "+endpointIn+", msg: "+message);
  //TODO: check: result.status
  //TODO: transferIn result.status === "bubble" chaining is on?
  return device.transferOut(endpointOut,message).then(outResult=>{
    util.log(outResult);
    //console.log(outResult.status);
    //printHexArray(outResult);
    util.log(outResult);
    //TODO: check for timeout, maybe clearHalt
    //TODO: set transferIn length to ccid class descriptor value
    return device.transferIn(endpointIn,ccidMaxMessageSize).then(inResult=>{
      util.log(inResult);
      //console.log(inResult.status);
      //printHexArray(inResult.data.buffer);
      util.log(inResult);
      return inResult.data.buffer;
    }); //.catch(error=>{console.log(error);});
  });
}

/**
 * Send message and receive answer.
 * - no CCID chaining support
 * @param  {[type]} message [description]
 * @return {Promise<ArrayBuffer>}         [description]
 */
function transceive (message) {
  if(Device==null) throw new Error("No device connected");
  //TODO: see USBDevice info in console, on selected Info
  let device = Device;
  let bulkInEndpoint = Reader.bulkInEndpoint;
  let bulkOutEndpoint = Reader.bulkOutEndpoint;
  let ccidMaxMessageSize = Reader.descriptor.SmartCardClassDescriptor.dwMaxCCIDMessageLength;
  if(message.length>ccidMaxMessageSize) throw new Error("Message too large. Max length is "+ccidMaxMessageSize+"bytes."); //TODO: support CCID chunking. Check Reader?
  return device.transferOut(bulkOutEndpoint,message).then(outResult=>{
    return device.transferIn(bulkInEndpoint,ccidMaxMessageSize).then(inResult=>{
      return inResult.data.buffer;
    });
  });
}

/**
 * Configure Ifd.
 * Options:
 * - hardwired device configuration
 * - find first valid interface
 * - find interface by inserted card
 * @param {USBDevice} device -
 * @param {Array<Object>} interfaces - list of interfaces read from Descriptor
 * @return {[type]} [description]
 */
function configure (device, interfaces) {

  //populate reader object by given parameters
  let getStaticConfiguration = (configurationNum,interfaceNum,alternateNum) =>  {
    //get additional reader data and create Reader configuration object
    let endpoints = device.configurations.find(c=>c.configurationValue===configurationNum)
      .interfaces.find(i=>i.interfaceNumber===interfaceNum)
      .alternates.find(a=>a.alternateSetting===alternateNum)
      .endpoints;
    let bulkOutEndpoint = endpoints.find(e=>e.direction==="out" && e.type==="bulk");
    let bulkInEndpoint = endpoints.find(e=>e.direction==="in" && e.type==="bulk");
    let interruptInEndpoint = endpoints.find(e=>e.direction==="in" && e.type==="interrupt");

    let reader = {
      vendorId: device.vendorId,
      productId: device.productId,
      configuration: configurationNum,
      interface: interfaceNum,
      alternate: alternateNum,
      bulkOutEndpoint: bulkOutEndpoint,
      bulkInEndpoint: bulkInEndpoint,
      interruptInEndpoint: interruptInEndpoint
    };
    return Promise.resolve(reader);
  };

  //return preconfigured reader object from included list
  let getSupportedConfiguration = () => {
    /**
     * Configuration data of supported card readers
     * @type {Array}
     */
    let supportedReaders = [
      {vendorId:0x04E6,productId:0x5720,configuration:1,interface:1,alternate:0,bulkOutEndpoint:1,bulkInEndpoint:2}, //Identiv uTrust 4700F CCID Reader
      {vendorId:0x04E6,productId:0x5790,configuration:1,interface:0,alternate:0,bulkOutEndpoint:1,bulkInEndpoint:2}, //Identiv CLOUD 3700F Contactless Reader
      {vendorId:0x1e57,productId:0x0008,configuration:1,interface:0,alternate:0,bulkOutEndpoint:2,bulkInEndpoint:2} //BDr-Federal CL-CCID [0142]
      //{vendorId:0x2581,productId:0xF1D0,configuration:null,interface:null,alternate:null,bulkOutEndpoint:null,bulkInEndpoint:null} //FIDO
    ];

    let reader = supportedReaders.find((element,index,array)=>{
      return device.productId === element.productId && device.vendorId === element.vendorId; //TODO: maybe check revision
    });

    return Promise.resolve(reader);
  };

  //try possible reader configuration by descriptor information
  let getAutodetectConfiguration = () => {
    //we have a USB device with at least one Smart Card class Interface Descriptor (see ccid.js:parseConfigurationDescriptor)
    if(device.configurations.length > 1) throw new Error("Only devices with 1 configuration supported.");



    //simple case: 1 configuration, 1 interface, 1 alternate
    if(device.configurations.length === 1 && interfaces.length === 1) {
      if(device.configurations[0].interfaces[0].alternates.length === 1) {
        let selectedConfiguration = device.configurations[0];
        let selectedInterface = selectedConfiguration.interfaces[0];
        let selectedAlternate = selectedInterface.alternates[0];
        return Promise.resolve(getStaticConfiguration(selectedConfiguration.configurationValue,selectedInterface.interfaceNumber,selectedAlternate.alternateSetting));
      }
    }

    //test case TODO: remove me
    if(device.configurations.length === 1 && interfaces.length === 2) {
      if(device.configurations[0].interfaces[1].alternates.length === 1) {
        let selectedConfiguration = device.configurations[0];
        let selectedInterface = selectedConfiguration.interfaces[1];
        let selectedAlternate = selectedInterface.alternates[0];
        return Promise.resolve(getStaticConfiguration(selectedConfiguration.configurationValue,selectedInterface.interfaceNumber,selectedAlternate.alternateSetting));
      }
    }

    //trial and error. TODO: implement
    if(device.configurations.length>1) {

      /**
 * Tries to detect configuration of a already requested reader
 * @return {[type]} [description]
 */
  let detectReader = (readerUSBDevice) => {
    readerUSBDevice = window.myusb; //for testing purposes
    let readerConfiguration = {vendorId: null, productId: null, configuration: null, interface:null,alternate:null, bulkOutEndpoint:null, bulkInEndpoint:null};
    readerConfiguration.vendorId = readerUSBDevice.vendorId;
    readerConfiguration.productId = readerUSBDevice.productId;

    let configurations = readerUSBDevice.configurations;
    configurations.forEach((value,index,array)=>{
      let configurationValue = value.configurationValue;
      let interfaces = value.interfaces;
      interfaces.forEach((interfaceObject, interfaceIndex,interfaceArray)=>{
        let interfaceNumber = interfaceObject.interfaceNumber;
        let alternates = interfaceObject.alternates;
        alternates.forEach((alternate,alternateIndex,alternateArray)=>{
          let alternateSetting = alternate.alternateSetting;
          let interfaceClass = alternate.interfaceClass;
          let endpoints = alternate.endpoints;


          //endpoints.forEach((endpoint,endpointIndex,endpointArray)=>{
          //  let endpointNumber = endpoint.endpointNumber;
          //  let direction = endpoint.direction;
          //  let type = endpoint.type;
          //});
        });
      });
    });
  };

  /*
  (async () => {for(let i=0;i<device.configurations.length;i++) {
   await (async () =>{
     //for every configuration do:

     for(let i=0;i<device.configuration.interfaces.length;i++) {
       await (async () => {
         //for every interface do:
         //claim interface, then watch alternatives

         let claimedInterface = device.configuration.interfaces.find(element=>{
           return element.claimed;
         });

         for(let i=0;i<claimedInterface.alternates.length;i++) {
           await (async ()=>{
             //for every altenate do:
             //select alternate
             //test alternate
             //let selectedAlternate = claimedInterface.alternate;
             //let endpoints = selectedAlternate.endpoints;
             //let interruptIn = endpoints.find(element=>{return element.type==="interrupt" && element.direction==="in";});
             //let bulkOut = endpoints.find(element=>{return element.type==="bulk" && element.direction==="out";});
             //let bulkIn = endpoints.find(element=>{return element.type==="bulk" && element.direction==="in";});

             //check endpoints
             //checkEndpoints(device,)
           })();
         }
       })();
     }
   })();
 }})();*/

  let hasCard = ()=>{
    return transceive(ccid.ccidMessages.PC_to_RDR_GetSlotStatus()).then(arrayBuffer => {
      util.log(arrayBuffer);
      let dataView = new DataView(arrayBuffer);
      bStatus = dataView.getUint8(7);
      bError = dataView.getUint8(8);

      let bmlCCStatus = bStatus &0x03;
      let bmCommandStatus = (bStatus>>6)&0x03;

      if(bmlCCStatus === 0 || bmlCCStatus === 1) {
        //card found
        //console.log("card found");
        return true;
      } else {
        //no card found
        //console.log("card not found");
        return false;
      }
    });
  };




    //naive approach to take first Interface and create Reader configuration object
    /*util.log(interfaces);
    let selectedConfiguration = device.configurations.find(c=>c.configurationValue===device.configurations[0].configurationValue);
    let selectedInterface = selectedConfiguration.interfaces.find(i=>i.interfaceNumber===interfaces[1].bInterfaceNumber);
    let selectedAlternate = selectedInterface.alternates.find(a=>a.alternateSetting===selectedInterface.alternates[0].alternateSetting);

    //TODO: test configuration
    return configureReader(reader,device,interfaces).then(()=>{
      console.log("check for card");
    });*/


    //device isn't configured yet, configuration and interface are not set yet.
    /*let endpoints = reader.configuration.interfaces.find(e=>e.claimed).alternate.endpoints;
    let bulkOutEndpoint = endpoints.find(e=>e.direction==="out" && e.type==="bulk");
    let bulkInEndpoint = endpoints.find(e=>e.direction==="in" && e.type==="bulk");
    let interruptInEndpoint = endpoints.find(e=>e.direction==="in" && e.type==="interrupt");*/

    }

    //reaching here means we couldn't configure it with any attempts above
    throw new Error("Please add your reader configuratino to suppoertedReaders variable. It could not be configured automatically.");
  };

  let configureReader = (reader, device, interfaces) => {
    Reader = reader;
    //util.log(interfaces);
    Reader.descriptor = interfaces.find(i=>i.bInterfaceNumber===reader.interface); //just selected interface
    Reader.device = device;
    util.log(Reader);

    if(reader) {
      return device.selectConfiguration(reader.configuration).then(()=>{ //almost always 1. Windows takes first configuration only.
        return device.claimInterface(reader.interface).then(() => { //contine after either .then or .error
          return device.selectAlternateInterface(reader.interface,reader.alternate).then(()=>{
            return device.reset();
          });
        });
      });

    }
  };

  //let reader = staticConfiguration(1,1,0);
  //let reader = supportedConfiguration();
  //let reader =
  return getAutodetectConfiguration().then(reader=>{return configureReader(reader, device, interfaces);});
}



/**
 * Init device operations: getFirstDevice, read ccid class descriptor
 * @return {Promise} [description]
 */
function init (device) { //TODO reset device? already done in ControlTransfer
  let initDevice = (device) => {
    Device = device;
    window.myusb = device; //TODO: remove debug variable
    //util.log(device); //log'd in Reader obj
    return getConfigurationDescriptor(device).then((USBSmartCardInterfaces)=> {
      Interfaces = USBSmartCardInterfaces;
      //util.log(USBSmartCardInterfaces); //log'd in Reader obj
      return configure(device, USBSmartCardInterfaces);
    });
  };

  if(device!=null) {
    return initDevice(device);
  } else {
    return getFirstUSBDevice().then(initDevice);
  }
}

/**
 * Initialization on connecting device
 * @return {[type]} [description]
 */
function registerUsbEventListeners () {
  window.navigator.usb.addEventListener("connect", connectEvent => {
    let device = connectEvent.device;
    return init(device);
    //TODO: notify ui on changed device status. Maybe optional callback function parameter
  });
  window.navigator.usb.addEventListener("disconnect", connectEvent => {
    util.log(connectEvent);
    //Device.close(); //cant call close on removed device
    Device = null;
    Interfaces = null;
    //TODO: notify ui on changed device status
  });
}
registerUsbEventListeners();

export {Device as USBDevice, Interfaces as SmartCardInterfaces, listenInterrupt, internalTransceive,transceive, configure, requestDevice, init};