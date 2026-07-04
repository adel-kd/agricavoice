const formData = new FormData();
formData.append("cropType", "wheat");
fetch("https://agrica-ethiopia.onrender.com/api/market/listings", {
  method: "POST",
  body: formData
}).then(res => {
  console.log("Status:", res.status);
  return res.text();
}).then(text => console.log("Response:", text)).catch(err => console.error("Fetch error:", err));
