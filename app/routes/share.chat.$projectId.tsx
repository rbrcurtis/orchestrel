import { useParams } from 'react-router';
import { ShareComposer } from '~/components/ShareComposer';

export default function ShareChatRoute() {
  const { projectId } = useParams();
  return <ShareComposer mode="chat" projectId={Number(projectId)} />;
}
