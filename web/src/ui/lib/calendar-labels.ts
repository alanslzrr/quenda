const months = {
  gl: ["xaneiro", "febreiro", "marzo", "abril", "maio", "xuño", "xullo", "agosto", "setembro", "outubro", "novembro", "decembro"],
  es: ["enero", "febrero", "marzo", "abril", "mayo", "junio", "julio", "agosto", "septiembre", "octubre", "noviembre", "diciembre"],
};
const weekdays = {
  gl: ["domingo", "luns", "martes", "mércores", "xoves", "venres", "sábado"],
  es: ["domingo", "lunes", "martes", "miércoles", "jueves", "viernes", "sábado"],
};
const shortWeekdays = { gl: ["dom", "lun", "mar", "mér", "xov", "ven", "sáb"], es: ["dom", "lun", "mar", "mié", "jue", "vie", "sáb"] };
// Explicit labels keep the two product languages intact on browsers with
// reduced locale data. The Date carries a civil day, not a booking instant.
export function calendarLabel(date: Date, locale: string, form: "month" | "weekday" | "full" | "long" | "day" | "short"): string {
  const language = locale.split("-")[0];
  if (language === "gl" || language === "es") {
    if (form === "weekday") return shortWeekdays[language][date.getDay()];
    const month = months[language][date.getMonth()];
    if (form === "month") return `${month} ${date.getFullYear()}`;
    if (form === "day") return `${weekdays[language][date.getDay()]}, ${date.getDate()} de ${month}`;
    if (form === "short") return `${shortWeekdays[language][date.getDay()]} ${date.getDate()} ${month.slice(0, 3)}`;
    const value = `${date.getDate()} de ${month} de ${date.getFullYear()}`;
    return form === "full" ? `${weekdays[language][date.getDay()]}, ${value}` : value;
  }
  const options: Intl.DateTimeFormatOptions = form === "month" ? {month:"long",year:"numeric"} : form === "weekday" ? {weekday:"short"} : form === "day" ? {weekday:"long",day:"numeric",month:"long"} : form === "short" ? {weekday:"short",day:"numeric",month:"short"} : {dateStyle:form};
  return new Intl.DateTimeFormat(locale, options).format(date);
}
