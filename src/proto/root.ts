import protobuf from "protobufjs";
import descriptor from "../generated/descriptor.json" with { type: "json" };

const root = protobuf.Root.fromJSON(descriptor as protobuf.INamespace);

export const MessageType = root.lookupType("Message");
