import { connection } from "next/server";
import StageEditor from "./editor";

export default async function StageEditorPage({ params }: { params: Promise<{ id: string }> }) {
  await connection();
  const { id } = await params;
  return <StageEditor sceneId={id} />;
}
