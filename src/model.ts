import { ChatOpenAI } from "@langchain/openai";

export const fullModel = new ChatOpenAI({ model: "gpt-4.1", temperature: 0 });
export const miniModel = new ChatOpenAI({ model: "gpt-4.1-mini", temperature: 0 });
export const nanoModel = new ChatOpenAI({ model: "gpt-4.1-nano", temperature: 0 });
