import { AgentRequest, AgentResponse } from "@/app/types/api";
import { NextResponse } from "next/server";

/** LangGraph + AgentKit require Node APIs — not Edge. */
export const runtime = "nodejs";
export const dynamic = "force-dynamic";
export const maxDuration = 120;
/**
 * Handles incoming POST requests to interact with the AgentKit-powered AI agent.
 * This function processes user messages and streams responses from the agent.
 *
 * @function POST
 * @param {Request & { json: () => Promise<AgentRequest> }} req - The incoming request object containing the user message.
 * @returns {Promise<NextResponse<AgentResponse>>} JSON response containing the AI-generated reply or an error message.
 *
 * @description Sends a single message to the agent and returns the agents' final response.
 *
 * @example
 * const response = await fetch("/api/agent", {
 *     method: "POST",
 *     headers: { "Content-Type": "application/json" },
 *     body: JSON.stringify({ userMessage: input }),
 * });
 */
export async function POST(
  req: Request & { json: () => Promise<AgentRequest & { threadId?: string }> },
): Promise<NextResponse<AgentResponse>> {
  try {
    // 1️. Extract user message and optional threadId from the request body
    const { userMessage, threadId } = await req.json();

    // 2. Get the agent (dynamic import avoids bundling viem/@noble during build)
    const { createAgent } = await import("./create-agent");
    const agent = await createAgent();

    // 3. Use provided threadId or generate a unique one for new conversations
    // This allows conversation continuity when the client sends the same threadId
    const conversationThreadId = threadId || `thread_${Date.now()}_${Math.random().toString(36).substring(7)}`;

    // 4. Start streaming the agent's response
    const stream = await agent.stream(
      { messages: [{ content: userMessage, role: "user" }] }, // The new message to send to the agent
      { configurable: { thread_id: conversationThreadId } }, // Thread ID for conversation tracking
    );

    // 4. Process streamed chunks (streamMode "updates" — last agent message wins)
    let agentResponse = "";
    for await (const chunk of stream) {
      if (chunk && typeof chunk === "object" && "agent" in chunk) {
        const agentChunk = chunk as { agent?: { messages?: Array<{ content?: unknown }> } };
        const content = agentChunk.agent?.messages?.[0]?.content;
        if (typeof content === "string") {
          agentResponse += content;
        }
      }
    }

    if (!agentResponse.trim()) {
      return NextResponse.json({
        error: "Agent returned no text. Check pm2 logs soteria-web for server errors.",
      });
    }

    // 5️. Return the final response
    return NextResponse.json({ response: agentResponse });
  } catch (error) {
    console.error("Error processing request:", error);
    return NextResponse.json({
      error:
        error instanceof Error
          ? error.message
          : "I'm sorry, I encountered an issue processing your message. Please try again later.",
    });
  }
}
