document.querySelectorAll('.alert').forEach((alert) => {
    setTimeout(() => alert.remove(), 5000);
});
