// single-user personal tool, not worth a timezone setting — hardcoded to IST (UTC+5:30).
export function timeGreeting(): string {
  const d = new Date();
  const istMinutes = (d.getUTCHours() * 60 + d.getUTCMinutes() + 330) % 1440;
  const h = Math.floor(istMinutes / 60);
  if (h >= 5 && h < 12) return "Good morning";
  if (h >= 12 && h < 17) return "Good afternoon";
  if (h >= 17 && h < 22) return "Good evening";
  return "Hello";
}
