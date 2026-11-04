import { Link } from "react-router-dom";
import { MailWarning } from "lucide-react";

// Aviso NEUTRO para tentativa de cadastro com e-mail já registrado.
// Não confirma que o endereço possui conta: orienta a entrar ou recuperar
// o acesso, evitando enumeração de usuários por quem não está autenticado.
export default function EmailInUseNotice() {
  return (
    <div
      role="alert"
      className="mb-4 rounded-lg border border-border bg-muted/50 p-4 text-sm"
    >
      <div className="flex items-start gap-2">
        <MailWarning className="w-4 h-4 text-muted-foreground mt-0.5 shrink-0" aria-hidden="true" />
        <div className="space-y-1">
          <p className="font-medium text-foreground">
            Não foi possível criar a conta com este e-mail.
          </p>
          <p className="text-muted-foreground">
            Se você já tem uma conta, entre com sua senha ou recupere o acesso.
          </p>
          <div className="flex items-center gap-2 pt-1">
            <Link to="/login" className="text-primary font-medium hover:underline">
              Entrar
            </Link>
            <span className="text-border" aria-hidden="true">•</span>
            <Link to="/forgot-password" className="text-primary font-medium hover:underline">
              Recuperar acesso
            </Link>
          </div>
        </div>
      </div>
    </div>
  );
}