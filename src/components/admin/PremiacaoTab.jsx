import { Tabs, TabsList, TabsTrigger, TabsContent } from "@/components/ui/tabs";
import AwardCategoriesManager from "@/components/admin/premiacao/AwardCategoriesManager";
import AwardNominationsManager from "@/components/admin/premiacao/AwardNominationsManager";
import AwardResultsView from "@/components/admin/premiacao/AwardResultsView";

export default function PremiacaoTab({ eventId }) {
  return (
    <Tabs defaultValue="categories">
      <TabsList>
        <TabsTrigger value="categories">Categorias</TabsTrigger>
        <TabsTrigger value="nominations">Indicações</TabsTrigger>
        <TabsTrigger value="results">Resultados</TabsTrigger>
      </TabsList>
      <TabsContent value="categories" className="mt-4"><AwardCategoriesManager eventId={eventId} /></TabsContent>
      <TabsContent value="nominations" className="mt-4"><AwardNominationsManager eventId={eventId} /></TabsContent>
      <TabsContent value="results" className="mt-4"><AwardResultsView eventId={eventId} /></TabsContent>
    </Tabs>
  );
}