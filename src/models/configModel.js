const { db } = require("../config/database");

async function getConfig(key) {
  const { data, error } = await db
    .from("system_config")
    .select("*")
    .eq("key", key)
    .order("created_at", { ascending: false })
    .limit(1);
  if (error) {
    throw new Error(error.message || "Error leyendo system_config");
  }
  if (!data || data.length === 0) {
    return null;
  }
  return data[0];
}

async function upsertConfig(key, value) {
  const existing = await getConfig(key);

  if (existing) {
    const { data, error } = await db
      .from("system_config")
      .eq("key", key)
      .update({ value });
    if (error) {
      throw new Error(error.message || "Error actualizando system_config");
    }
    return Array.isArray(data) ? data[0] : data;
  }

  const { data, error } = await db.from("system_config").insert({ key, value });
  if (error) {
    throw new Error(error.message || "Error creando system_config");
  }
  return Array.isArray(data) ? data[0] : data;
}

module.exports = {
  getConfig,
  upsertConfig,
};
