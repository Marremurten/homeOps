type ContentType = "acknowledgment" | "clarification" | "adaptation_hint" | "query_result";
type ChatType = "private" | "group" | "supergroup";

export interface RouteParams {
  contentType: ContentType;
  isDmOptedIn: boolean;
  chatType: ChatType;
}

export function routeResponse(params: RouteParams): string {
  const { contentType, isDmOptedIn, chatType } = params;

  if (chatType === "private") {
    return "dm";
  }

  if (contentType === "adaptation_hint") {
    return isDmOptedIn ? "dm" : "none";
  }

  return "group";
}
