const mask = '••••••••';

export class ApiKeyField {
  constructor(input) {
    this.input = input;
    input.addEventListener('focus', () => { if (this.masked) input.select(); });
    input.addEventListener('input', () => {
      if (this.masked) input.value = input.value.replaceAll('•', '');
      this.masked = false; this.edited = true;
    });
    this.reset();
  }
  reset(hasKey = false) { this.edited = false; this.update(hasKey); }
  update(hasKey) {
    if (!this.edited) { this.masked = !!hasKey; this.input.value = hasKey ? mask : ''; }
    this.input.placeholder = '可选';
  }
  patch() {
    const value = this.input.value;
    if (!this.edited && (this.masked ? value === mask : value === '')) return {};
    return { apiKey: (this.masked ? value.replaceAll('•', '') : value).trim() };
  }
}
