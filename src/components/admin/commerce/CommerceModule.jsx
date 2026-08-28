import { useState } from "react";
import { Ticket, Tag, ShieldCheck, Receipt } from "lucide-react";
import TicketTypesLotsTab from "./TicketTypesLotsTab";
import CouponsTab from "./CouponsTab";
import RefundPolicyTab from "./RefundPolicyTab";
import TransactionsTab from "./TransactionsTab";

const TABS = [
  { id: "lots", label: "Tipos & Lotes", icon: Ticket },
  { id: "coupons", label: "Cupons", icon: Tag },
  { id: "policy", label: "Política de Estorno", icon: ShieldCheck },
  { id: "transactions", label: "Transações", icon: Receipt },
];

export default function CommerceModule({ eventId, hasAccess, user }) {
  const [tab, setTab] = useState("lots");

  return (
    <div className="space-y-4">
      <div className="flex gap-2 overflow-x-auto pb-1 -mx-1 px-1">
        {TABS.map(({ id, label, icon: Icon }) => (
          <button
            key={id}
            onClick={() => setTab(id)}
            className={`shrink-0 inline-flex items-center gap-1.5 px-3.5 py-2 rounded-full text-sm font-medium transition-colors touch-manipulation select-none ${
              tab === id
                ? "bg-primary text-primary-foreground"
                : "bg-card border border-border text-muted-foreground hover:text-foreground"
            }`}
          >
            <Icon className="w-4 h-4" />
            {label}
          </button>
        ))}
      </div>

      {tab === "lots" && <TicketTypesLotsTab eventId={eventId} hasAccess={hasAccess} />}
      {tab === "coupons" && <CouponsTab eventId={eventId} hasAccess={hasAccess} />}
      {tab === "policy" && <RefundPolicyTab eventId={eventId} hasAccess={hasAccess} user={user} />}
      {tab === "transactions" && <TransactionsTab eventId={eventId} user={user} />}
    </div>
  );
}