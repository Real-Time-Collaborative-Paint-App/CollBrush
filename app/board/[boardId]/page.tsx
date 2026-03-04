import CollaborativeBoard from "@/components/CollaborativeBoard";

type BoardPageProps = {
  params: Promise<{ boardId: string }>;
};

export default async function BoardPage({ params }: BoardPageProps) {
  const { boardId } = await params;
  const safeBoardId = decodeURIComponent(boardId).slice(0, 80);

  return <CollaborativeBoard boardId={safeBoardId} />;
}
