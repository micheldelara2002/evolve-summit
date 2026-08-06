import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import AwardConfigsManager from "@/components/admin/premiacao/AwardConfigsManager";
import AwardSubmissionsManager from "@/components/admin/premiacao/AwardSubmissionsManager";
import AwardResultsView from "@/components/admin/premiacao/AwardResultsView";

export default function PremiacaoTab({ eventId, hasAccess, user }) {
  return (
    <Tabs defaultValue="configs">
      <TabsList>
        <TabsTrigger value="configs">Configurações</TabsTrigger>
        <TabsTrigger value="submissions">Inscrições</TabsTrigger>
        <TabsTrigger value="results">Resultados</TabsTrigger>
      </TabsList>
      <TabsContent value="configs" className="mt-4"><AwardConfigsManager eventId={eventId} hasAccess={hasAccess} /></TabsContent>
      <TabsContent value="submissions" className="mt-4"><AwardSubmissionsManager eventId={eventId} hasAccess={hasAccess} user={user} /></TabsContent>
      <TabsContent value="results" className="mt-4"><AwardResultsView eventId={eventId} /></TabsContent>
    </Tabs>
  );
}