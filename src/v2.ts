// OpenCode 2.0.26 SessionTransfer <-> the editor's message/parts view.
// Keep native fields on the view so attachments, provider data and timeline
// events survive edits without being converted to v1 messages.
export function fromV2(data: any): any {
  return {
    info: { ...data.info, directory: data.info.location.directory, _format: 2 },
    messages: data.messages.map((message: any) => {
      const { content, text, ...native } = message;
      let parts: any[];
      if (message.type === "assistant") {
        parts = content.map((part: any, index: number) => ({
          ...part, id: `${message.id}_${index}`,
          ...(part.type === "tool" ? { callID: part.id, tool: part.name } : {}),
        }));
      } else if (typeof text === "string") {
        parts = [{ type: "text", text }];
      } else if (message.type === "compaction" && message.status !== "failed") {
        parts = ["summary", "recent"].map(field => ({ type: "text", text: message[field], _field: field }));
        delete native.summary;
        delete native.recent;
      } else {
        parts = [{ type: "event", text: JSON.stringify(message, null, 2) }];
      }
      return { info: { id: message.id, role: message.type, time: message.time, _v2: native }, parts };
    }),
  };
}

export function toV2(data: any): any {
  const { _format, directory, ...info } = data.info;
  const messages = data.messages.map((message: any) => {
    const role = message.info.role;
    const original = message.info._v2;
    const native = original?.type === role ? structuredClone(original) : {};
    const result: any = {
      ...native, id: message.info.id, type: role,
      time: native.time || message.info.time || { created: Date.now() },
    };
    if (role === "assistant") {
      result.agent ||= info.agent || "build";
      result.model ||= info.model;
      if (!result.model) throw new Error("助手消息缺少模型，请从包含模型信息的会话中编辑");
      // Native import silently omits unfinished assistant messages.
      result.time = { ...result.time, completed: result.time.completed ?? result.time.created };
      result.content = message.parts.map((part: any) => {
        const { id, messageID, sessionID, callID, tool, _field, ...content } = structuredClone(part);
        if (part.type === "tool") {
          content.id = callID;
          content.name = tool;
          if (content.state.status === "completed" && (!Array.isArray(content.state.content) || !content.state.content.length)) {
            throw new Error("工具输出必须是非空 content 数组");
          }
        } else if (part.type === "reasoning") {
          if (content.time?.start !== undefined) content.time = { created: content.time.start, completed: content.time.end };
          // Edited reasoning can no longer carry a valid Anthropic signature.
          if (content.state) delete content.state.anthropic;
        } else if (part.type !== "text") {
          throw new Error(`助手消息不支持 ${part.type} 内容`);
        }
        return content;
      });
    } else if (["user", "system", "synthetic", "skill"].includes(role)) {
      if (message.parts.some((part: any) => part.type !== "text")) {
        throw new Error(`${role} 消息只支持文本；请先移除工具或推理再切换角色`);
      }
      result.text = message.parts.map((part: any) => part.text).join("\n");
    } else if (role === "compaction" && result.status !== "failed") {
      for (const field of ["summary", "recent"]) result[field] = message.parts.find((p: any) => p._field === field)?.text ?? "";
    } else if (!original) {
      throw new Error(`不支持的新消息类型：${role}`);
    }
    return result;
  });
  return { info, messages };
}
