/**
 * Subpath entry: @gettalon/channels-sdk/protocol
 *
 * Transport-agnostic protocol types, serialization, and message definitions.
 */

// Message type enum + serialization
export {
  MessageType,
  serialize,
  deserialize,
  serializeBuffer,
  deserializeBuffer,
  createEnvelope,
} from "../protocol.js";

// Protocol message types
export type {
  ProtocolMessage,
  RegisterMessage,
  RegisterAckMessage,
  HeartbeatMessage,
  HeartbeatAckMessage,
  ToolCallMessage,
  ToolResultMessage,
  ChatMessage,
  ReplyMessage,
  PermissionRequestMessage,
  PermissionVerdictMessage,
  FileTransferMessage,
  GroupBroadcastMessage,
  GroupInfoMessage,
  InviteMessage,
  ReleaseMessage,
  HandoverRequestMessage,
  AckMessage,
  StreamStartMessage,
  StreamChunkMessage,
  StreamEndMessage,
  RichMessageParams,
} from "../protocol.js";

// Agent & transport interface types
export type {
  AgentToolDef,
  ConnectedAgent,
  Transport,
  TransportAdapter,
  ConnectionHandler,
  MessageHandler,
  SessionEnvelope,
  RecipientFilter,
  MessageTypeName,
} from "../protocol.js";

// Channel/transport registry
export {
  registerChannel,
  createChannel,
  listChannels,
  registerTransport,
  createTransport,
  listTransports,
  transportRequiresE2E,
  registerMessageType,
  getMessageHandler,
  listMessageTypes,
} from "../protocol.js";

export type {
  ChannelFactory,
  TransportFactory,
  MessageTypeHandler,
  DiscoveredServer,
  DiscoverySource,
} from "../protocol.js";

export { discover } from "../protocol.js";
