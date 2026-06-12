import { motion } from "framer-motion";

export default function KpiCard({ label, value, icon: Icon, color = "text-primary", subtitle }) {
  return (
    <motion.div
      initial={{ opacity: 0, y: 12 }}
      animate={{ opacity: 1, y: 0 }}
      className="flex items-center gap-3 p-3 rounded-xl bg-muted/50"
    >
      {Icon && (
        <div className={`w-10 h-10 rounded-lg flex items-center justify-center bg-card shadow-sm ${color}`}>
          <Icon className="w-5 h-5" />
        </div>
      )}
      <div className="min-w-0 flex-1">
        <p className="text-xs text-muted-foreground truncate">{label}</p>
        <p className="text-lg font-bold leading-tight">{value}</p>
        {subtitle && <p className="text-xs text-muted-foreground mt-0.5">{subtitle}</p>}
      </div>
    </motion.div>
  );
}