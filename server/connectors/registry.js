'use strict';

// adapter type  →  implementation. Add a protocol by dropping a file in
// adapters/ and one line here.
module.exports = {
  simulator: require('./adapters/simulator'),
  hl7v2: require('./adapters/hl7v2'),
  fhir: require('./adapters/fhir'),
  'tcp-ascii': require('./adapters/tcp-ascii'),
  'file-poll': require('./adapters/file-poll'),
  serial: require('./adapters/serial'),
  'modbus-tcp': require('./adapters/modbus-tcp'),
  opcua: require('./adapters/opcua'),
};
