export default function PersonAvatar({ person, size = "md" }) {
  const sizes = { sm: "w-8 h-8 text-xs", md: "w-10 h-10 text-sm", lg: "w-14 h-14 text-lg" };
  const cls = sizes[size];
  const initials = person?.full_name
    ? person.full_name.split(" ").map((w) => w[0]).slice(0, 2).join("").toUpperCase()
    : "?";

  if (person?.photo_url) {
    return <img src={person.photo_url} alt={person.full_name} className={`${cls} rounded-full object-cover shrink-0`} />;
  }
  return (
    <div className={`${cls} rounded-full bg-primary/10 text-primary font-display font-bold flex items-center justify-center shrink-0`}>
      {initials}
    </div>
  );
}