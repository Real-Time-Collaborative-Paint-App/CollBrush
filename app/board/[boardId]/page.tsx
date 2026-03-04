import CollaborativeBoard from "@/components/CollaborativeBoard";

type BoardPageProps = {
  params: Promise<{ boardId: string }>;
  searchParams: Promise<{ uid?: string; name?: string }>;
};

export default async function BoardPage({ params, searchParams }: BoardPageProps) {
  const { boardId } = await params;
  const { uid, name } = await searchParams;
  const safeBoardId = decodeURIComponent(boardId).slice(0, 80);
  const safeUserId = decodeURIComponent(uid ?? "").slice(0, 80);
  const safeNickname = decodeURIComponent(name ?? "").slice(0, 40);

  return (
    <CollaborativeBoard
      boardId={safeBoardId}
      userId={safeUserId}
      nickname={safeNickname}
    />
  );
}
