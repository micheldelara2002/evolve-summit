import { useNavigate } from "react-router-dom";
import { Users } from "lucide-react";
import { Button } from "@/components/ui/button";

export default function AdminPeoplePlaceholder() {
  const navigate = useNavigate();

  return (
    <div className="flex flex-col items-center justify-center min-h-[60vh] text-center gap-6 px-4">
      <div className="w-16 h-16 rounded-2xl bg-teal-50 flex items-center justify-center">
        <Users className="w-8 h-8 text-teal-600" />
      </div>
      <div>
        <h1 className="text-2xl font-display font-bold">Gestão Global de Pessoas</h1>
        <p className="text-muted-foreground mt-2 max-w-sm">
          Módulo em construção. Funcionalidades sendo implementadas.
        </p>
      </div>
      <Button variant="outline" onClick={() => navigate("/")}>
        Voltar para Home
      </Button>
    </div>
  );
}