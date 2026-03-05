import { describe, expect, it } from "vitest";
import { buildBoardPresenceQuery } from "./board-presence";

describe("board presence query builder", () => {
  it("builds encoded boardId query params", () => {
    const query = buildBoardPresenceQuery(["board-1", "room with space", "привет"]);
    expect(query).toBe(
      "boardId=board-1&boardId=room%20with%20space&boardId=%D0%BF%D1%80%D0%B8%D0%B2%D0%B5%D1%82",
    );
  });
});
