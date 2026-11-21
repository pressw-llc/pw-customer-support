import { and, eq, gt, isNull, lte, or, sql } from "drizzle-orm";
import { inTransaction, type SupportExecutor } from "./client";
import {
  cancelHeldReplyFor,
  type InboundCommentRow,
  type ReplyRow,
} from "./replies";
import { commentChanges, inboundComments, replies } from "./schema";

const PROVIDER = "linear";

export interface FetchedComment {
  issueId: string;
  body: string;
  parentCommentId: string | null;
  authorId: string | null;
  authorName: string | null;
  createdAt: Date;
  updatedAt: Date;
}

export type RefreshOutcome =
  | { status: "missing" }
  | { status: "removed" }
  | { status: "issue_mismatch" }
  | { status: "refreshed" }
  | { status: "cancelled"; reply: ReplyRow };

export async function commentNeedsRefresh(
  db: SupportExecutor,
  inbound: InboundCommentRow,
): Promise<boolean> {
  if (inbound.refetchRequired) return true;
  const [row] = await db
    .select({ commentId: commentChanges.commentId })
    .from(commentChanges)
    .where(
      and(
        eq(commentChanges.provider, inbound.provider),
        eq(commentChanges.commentId, inbound.commentId),
        inbound.sourceUpdatedAt
          ? gt(commentChanges.updatedAt, inbound.sourceUpdatedAt)
          : undefined,
      ),
    );
  return row !== undefined;
}

export async function listHeldNeedingRefresh(
  db: SupportExecutor,
  requestId: string,
  threadRootId: string,
): Promise<InboundCommentRow[]> {
  const rows = await db
    .select({ inbound: inboundComments })
    .from(replies)
    .innerJoin(
      inboundComments,
      eq(inboundComments.id, replies.inboundCommentId),
    )
    .innerJoin(
      commentChanges,
      and(
        eq(commentChanges.provider, inboundComments.provider),
        eq(commentChanges.commentId, inboundComments.commentId),
      ),
    )
    .where(
      and(
        eq(replies.requestId, requestId),
        eq(replies.threadRootId, threadRootId),
        eq(replies.status, "held"),
        or(
          isNull(inboundComments.sourceUpdatedAt),
          gt(commentChanges.updatedAt, inboundComments.sourceUpdatedAt),
        ),
      ),
    );
  return rows.map((row) => row.inbound);
}

export async function applyFetchedComment(
  db: SupportExecutor,
  inboundId: string,
  fetched: FetchedComment | null,
): Promise<RefreshOutcome> {
  return inTransaction(db, async (tx) => {
    const [inbound] = await tx
      .select()
      .from(inboundComments)
      .where(eq(inboundComments.id, inboundId))
      .for("update");
    if (!inbound) return { status: "missing" };
    const clearChanges = (through: Date | null) =>
      tx
        .delete(commentChanges)
        .where(
          and(
            eq(commentChanges.provider, PROVIDER),
            eq(commentChanges.commentId, inbound.commentId),
            through ? lte(commentChanges.updatedAt, through) : undefined,
          ),
        );
    if (fetched === null) {
      await clearChanges(null);
      if (inbound.status === "pending") {
        await tx
          .update(inboundComments)
          .set({
            status: "processed",
            disposition: "removed",
            body: "",
            authorId: null,
            authorName: null,
            refetchRequired: false,
            processedAt: sql`now()`,
          })
          .where(eq(inboundComments.id, inbound.id));
        return { status: "removed" };
      }
      const cancelled = await cancelHeldReplyFor(tx, inbound, "removed");
      return cancelled
        ? { status: "cancelled", reply: cancelled }
        : { status: "removed" };
    }
    if (fetched.issueId !== inbound.issueId) {
      await tx
        .update(inboundComments)
        .set({
          status: "processed",
          disposition: "ignored:issue_mismatch",
          body: "",
          authorId: null,
          authorName: null,
          refetchRequired: false,
          processedAt: sql`now()`,
        })
        .where(eq(inboundComments.id, inbound.id));
      return { status: "issue_mismatch" };
    }
    await clearChanges(fetched.updatedAt);
    if (inbound.status === "pending") {
      await tx
        .update(inboundComments)
        .set({
          body: fetched.body,
          authorId: fetched.authorId,
          authorName: fetched.authorName,
          parentCommentId: fetched.parentCommentId,
          sourceCreatedAt: fetched.createdAt,
          sourceUpdatedAt: fetched.updatedAt,
          refetchRequired: false,
        })
        .where(eq(inboundComments.id, inbound.id));
      return { status: "refreshed" };
    }
    const edited = fetched.body !== inbound.body;
    await tx
      .update(inboundComments)
      .set({ body: fetched.body, sourceUpdatedAt: fetched.updatedAt })
      .where(eq(inboundComments.id, inbound.id));
    if (!edited) return { status: "refreshed" };
    const cancelled = await cancelHeldReplyFor(tx, inbound, "edited");
    return cancelled
      ? { status: "cancelled", reply: cancelled }
      : { status: "refreshed" };
  });
}
