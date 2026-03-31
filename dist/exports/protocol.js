/**
 * Subpath entry: @gettalon/channels-sdk/protocol
 *
 * Transport-agnostic protocol types, serialization, and message definitions.
 */
// Message type enum + serialization
export { MessageType, serialize, deserialize, serializeBuffer, deserializeBuffer, createEnvelope, } from "../protocol.js";
// Channel/transport registry
export { registerChannel, createChannel, listChannels, registerTransport, createTransport, listTransports, transportRequiresE2E, registerMessageType, getMessageHandler, listMessageTypes, } from "../protocol.js";
export { discover } from "../protocol.js";
//# sourceMappingURL=protocol.js.map