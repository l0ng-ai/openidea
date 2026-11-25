import { describe, expect, it } from "vitest";
import { railsReferenceAt } from "./references";

const at = (text: string, routes = false) => railsReferenceAt(text.replace("|", ""), text.indexOf("|"), routes);

describe("rails references", () => {
  it("reads method symbols in callbacks", () => {
    expect(at("  before_action :load_|user, only: [:show]")).toEqual({
      kind: "method",
      name: "load_user",
      from: 17,
      to: 26,
    });
    expect(at("  before_action :load_user, if: :ad|min?")).toMatchObject({ name: "admin?" });
    expect(at("  skip_before_action :auth|enticate!")).toMatchObject({ name: "authenticate!" });
    expect(at("  helper_method :current|_user")).toMatchObject({ name: "current_user" });
    expect(at("  validate :email_|format")).toMatchObject({ name: "email_format" });
    expect(at("  has_many :po|sts")).toBeNull();
    expect(at("  before_action Foo::Ba|r")).toBeNull();
  });

  it("reads controller actions in routes", () => {
    expect(at('  get "login", to: "sess|ions#new"', true)).toMatchObject({ resource: "sessions", action: "new" });
    expect(at("  get '/x' => 'admin/rep|orts#index'", true)).toMatchObject({
      resource: "admin/reports",
      action: "index",
    });
    expect(at("  resources :pho|tos", true)).toMatchObject({ resource: "photos", action: null });
    expect(at("  resources :users, :pos|ts", true)).toMatchObject({ resource: "posts" });
    expect(at("  resource :prof|ile", true)).toMatchObject({ resource: "profiles" });
    expect(at("  root 'pages#ho|me'", true)).toMatchObject({ resource: "pages", action: "home" });
    expect(at("  mount Sidekiq::W|eb", true)).toBeNull();
  });
});
