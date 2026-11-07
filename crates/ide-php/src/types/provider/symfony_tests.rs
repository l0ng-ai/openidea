use std::path::Path;

use crate::summary::FileSummary;
use crate::symfony::SymfonyConfig;
use crate::syntax::ParsedFile;
use crate::types::provider::{ArgumentOf, KnownKind};
use crate::types::{Context, Resolver, SummarySet, Type, TypeCache, TypeProviders, type_at};

const CARET: &str = "/*|*/";

/// Just enough of the PSR container, Symfony's container and Doctrine (the
/// signatures and templates as the libraries declare them, the bodies
/// empty).
pub(crate) const LIBRARIES: &str = r#"<?php
namespace Psr\Container {
    interface ContainerInterface {
        /** @return mixed */
        public function get(string $id);
        public function has(string $id): bool;
    }
}
namespace Symfony\Component\DependencyInjection {
    interface ContainerInterface extends \Psr\Container\ContainerInterface {
        public function get(string $id, int $invalidBehavior = 1): ?object;
    }
}
namespace Doctrine\Persistence {
    /** @template-covariant T of object */
    interface ObjectRepository {
        /** @return T|null */
        public function find($id);
        /** @return array<int, T> */
        public function findAll();
        /** @return array<int, T> */
        public function findBy(array $criteria);
        /** @return T|null */
        public function findOneBy(array $criteria);
    }
    interface ObjectManager {
        /**
         * @param class-string<T> $className
         * @return ObjectRepository<T>
         * @template T of object
         */
        public function getRepository(string $className);
    }
    interface ManagerRegistry {
        /**
         * @param class-string<T> $persistentObject
         * @return ObjectRepository<T>
         * @template T of object
         */
        public function getRepository(string $persistentObject, ?string $persistentManagerName = null);
    }
}
namespace Doctrine\ORM {
    /**
     * @template T of object
     * @template-implements \Doctrine\Persistence\ObjectRepository<T>
     */
    class EntityRepository implements \Doctrine\Persistence\ObjectRepository {
        public function find($id) { return null; }
        public function findAll() { return []; }
        public function findBy(array $criteria) { return []; }
        public function findOneBy(array $criteria) { return null; }
        public function count(array $criteria = []): int { return 0; }
        public function __call($method, $arguments): mixed { return null; }
    }
    interface EntityManagerInterface extends \Doctrine\Persistence\ObjectManager {
        /**
         * @param class-string<T> $className
         * @return EntityRepository<T>
         * @template T of object
         */
        public function getRepository(string $className);
    }
}
namespace Doctrine\ORM\Mapping {
    #[\Attribute]
    final class Entity {
        public function __construct(public ?string $repositoryClass = null) {}
    }
}
namespace Doctrine\Bundle\DoctrineBundle\Repository {
    /**
     * @template T of object
     * @template-extends \Doctrine\ORM\EntityRepository<T>
     */
    class ServiceEntityRepository extends \Doctrine\ORM\EntityRepository {
        public function __construct(\Doctrine\Persistence\ManagerRegistry $registry, string $entityClass) {}
    }
}
namespace Symfony\Component\Routing\Generator {
    interface UrlGeneratorInterface {
        public function generate(string $name, array $parameters = []): string;
    }
}
namespace Symfony\Component\Routing\Attribute {
    #[\Attribute]
    class Route {
        public function __construct(string|array|null $path = null, ?string $name = null) {}
    }
}
namespace Symfony\Bundle\FrameworkBundle\Controller {
    abstract class AbstractController {
        protected function generateUrl(string $route, array $parameters = []): string { return ''; }
        protected function redirectToRoute(string $route, array $parameters = []): object { return new \stdClass(); }
    }
}
"#;

/// The class that says symfony/framework-bundle is installed.
pub(crate) const FRAMEWORK_BUNDLE: &str = r#"<?php
namespace Symfony\Bundle\FrameworkBundle;
class FrameworkBundle {}
"#;

pub(crate) const APP: &str = r#"<?php
namespace App\Service {
    class Mailer {
        public function send(string $to): bool { return true; }
    }
}
namespace App\Entity {
    use App\Repository\ProductRepository;
    use Doctrine\ORM\Mapping as ORM;
    #[ORM\Entity(repositoryClass: ProductRepository::class)]
    class Product {
        private ?int $id = null;
        private string $name = '';
        private static int $instances = 0;
    }
    #[ORM\Entity]
    class Tag {
        private string $label = '';
    }
    #[ORM\Entity(repositoryClass: \App\Repository\LegacyRepository::class)]
    class Legacy {}
    #[ORM\Entity]
    class Post {
        private string $title = '';
    }
}
namespace App\Repository {
    use App\Entity\Product;
    use Doctrine\Bundle\DoctrineBundle\Repository\ServiceEntityRepository;
    /** @extends ServiceEntityRepository<Product> */
    class ProductRepository extends ServiceEntityRepository {
        public function cheapest(): ?Product { return null; }
        /** @return Product[] */
        public function findByName(string $name): array { return []; }
    }
    /** A repository without generics: its entity's mapping names it. */
    class LegacyRepository extends ServiceEntityRepository {}
    /** A repository without generics naming its entity to the parent. */
    class PostRepository extends ServiceEntityRepository {
        public function __construct(\Doctrine\Persistence\ManagerRegistry $registry) {
            parent::__construct($registry, \App\Entity\Post::class);
        }
    }
    /** A repository whose entity nothing names. */
    class OrphanRepository extends ServiceEntityRepository {}
}
namespace App\Controller {
    use Symfony\Bundle\FrameworkBundle\Controller\AbstractController;
    use Symfony\Component\Routing\Attribute\Route;
    #[Route('/blog', name: 'blog_')]
    class BlogController extends AbstractController {
        #[Route('/{slug}', name: 'show')]
        public function show() {}
    }
}
"#;

const HEADER: &str = "<?php
namespace Main;
use App\\Entity\\{Product, Tag, Legacy};
use App\\Repository\\{ProductRepository, PostRepository, OrphanRepository};
use App\\Service\\Mailer;
use Doctrine\\ORM\\{EntityManagerInterface, EntityRepository};
use Doctrine\\Persistence\\ManagerRegistry;
use Psr\\Container\\ContainerInterface as Psr;
use Symfony\\Component\\DependencyInjection\\ContainerInterface;
";

/// The declarations of `libs`, `main` (the source with the caret removed)
/// first.
fn summaries(libs: &[&str], main: &ParsedFile) -> SummarySet {
    let mut summaries = vec![FileSummary::extract(main)];
    for (i, lib) in libs.iter().enumerate() {
        let lib = ParsedFile::parse(format!("lib{i}.php").as_str(), *lib);
        assert!(!lib.has_errors(), "{:?}", lib.errors());
        summaries.push(FileSummary::extract(&lib));
    }
    SummarySet::new(summaries)
}

/// The type at the caret in `HEADER` + `body`, the `libs` declared too.
fn type_in(libs: &[&str], body: &str) -> String {
    type_with(libs, &SymfonyConfig::default(), body)
}

/// [`type_in`] with a Symfony configuration.
fn type_with(libs: &[&str], config: &SymfonyConfig, body: &str) -> String {
    let source = format!("{HEADER}{body}");
    let offset = source.find(CARET).unwrap_or_else(|| panic!("no caret in {source}"));
    let source = source.replacen(CARET, "", 1);
    let file = ParsedFile::parse("main.php", source.as_str());
    assert!(!file.has_errors(), "{source}: {:?}", file.errors());
    let mut decls = summaries(libs, &file);
    decls.symfony_config = config.clone();
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    type_at(&file, &resolver, offset as u32).map(|ty| ty.to_string()).unwrap_or_else(|| "<none>".to_owned())
}

fn check(libs: &[&str], cases: &[(&str, &str)]) {
    let failures: Vec<String> = cases
        .iter()
        .filter_map(|(body, expected)| {
            let got = type_in(libs, body);
            (got != *expected).then(|| format!("{body}\n  expected {expected}\n  got      {got}"))
        })
        .collect();
    assert!(failures.is_empty(), "{}", failures.join("\n"));
}

const INSTALLED: &[&str] = &[LIBRARIES, FRAMEWORK_BUNDLE, APP];

#[test]
fn container_get_by_class_id() {
    check(
        INSTALLED,
        &[
            ("function f(ContainerInterface $c) { $c->get(Mailer::class)/*|*/; }", "App\\Service\\Mailer"),
            ("function f(ContainerInterface $c) { $c->get('App\\Service\\Mailer')/*|*/; }", "App\\Service\\Mailer"),
            ("function f(Psr $c) { $c->get(Mailer::class)/*|*/; }", "App\\Service\\Mailer"),
            ("function f(Psr $c) { $c->get(Mailer::class)->send('a')/*|*/; }", "bool"),
            // Ids only services.yaml defines, and dynamic ones, keep what
            // the core says (PSR's inherited `@return mixed`).
            ("function f(ContainerInterface $c) { $c->get('mailer.default')/*|*/; }", "mixed"),
            ("function f(Psr $c) { $c->get('mailer.default')/*|*/; }", "mixed"),
            ("function f(ContainerInterface $c, string $id) { $c->get($id)/*|*/; }", "mixed"),
            // Not a container.
            ("function f(Mailer $m) { $m->get(Mailer::class)/*|*/; }", "mixed"),
        ],
    );
}

#[test]
fn doctrine_get_repository() {
    let tags = "Doctrine\\ORM\\EntityRepository<App\\Entity\\Tag>";
    check(
        INSTALLED,
        &[
            // The entity's repository class.
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Product::class)/*|*/; }",
                "App\\Repository\\ProductRepository",
            ),
            (
                "function f(ManagerRegistry $r) { $r->getRepository(Product::class)/*|*/; }",
                "App\\Repository\\ProductRepository",
            ),
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Product::class)->cheapest()/*|*/; }",
                "?App\\Entity\\Product",
            ),
            // No repository class: the documented generic repository.
            ("function f(EntityManagerInterface $em) { $em->getRepository(Tag::class)/*|*/; }", tags),
        ],
    );
}

#[test]
fn doctrine_repository_finders() {
    let products = "list<App\\Entity\\Product>";
    let product = "?App\\Entity\\Product";
    check(
        INSTALLED,
        &[
            ("function f(ProductRepository $r) { $r->findOneByName('a')/*|*/; }", product),
            // Through a summary: an untyped function's return.
            (
                "function g(ProductRepository $r) { return $r->findOneByName('a'); }\ng(new ProductRepository())/*|*/;",
                product,
            ),
            ("function f(ProductRepository $r) { $r->findBySku('a')/*|*/; }", products),
            ("function f(ProductRepository $r) { $r->countByName('a')/*|*/; }", "int"),
            ("function f(ProductRepository $r) { $r->findOneBy([])/*|*/; }", product),
            ("function f(ProductRepository $r) { $r->find(1)/*|*/; }", product),
            // Declared and documented methods win.
            ("function f(ProductRepository $r) { $r->findByName('a')/*|*/; }", "App\\Entity\\Product[]"),
            ("function f(ProductRepository $r) { $r->count()/*|*/; }", "int"),
            // Through getRepository() and on a generic repository.
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Product::class)->findOneByName('a')/*|*/; }",
                product,
            ),
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Tag::class)->findByLabel('a')/*|*/; }",
                "list<App\\Entity\\Tag>",
            ),
            // A documented `EntityRepository<Tag>`.
            (
                "/** @param EntityRepository<Tag> $r */\nfunction f(EntityRepository $r) { $r->findOneByLabel('a')/*|*/; }",
                "?App\\Entity\\Tag",
            ),
            // Repositories without generics: the entity whose mapping names
            // the repository, or the one its constructor names.
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Legacy::class)->findOneByName('a')/*|*/; }",
                "?App\\Entity\\Legacy",
            ),
            ("function f(PostRepository $r) { $r->findOneByTitle('a')/*|*/; }", "?App\\Entity\\Post"),
            ("function f(PostRepository $r) { $r->findAll()/*|*/; }", "list<App\\Entity\\Post>"),
            // A repository whose entity isn't known stays unknown.
            ("function f(OrphanRepository $r) { $r->findOneByName('a')/*|*/; }", "mixed"),
            // Not a repository.
            ("function f(Mailer $m) { $m->findOneByName('a')/*|*/; }", "mixed"),
        ],
    );
}

#[test]
fn off_without_the_framework_bundle() {
    check(
        &[LIBRARIES, APP],
        &[
            ("function f(Psr $c) { $c->get(Mailer::class)/*|*/; }", "mixed"),
            ("function f(ContainerInterface $c) { $c->get(Mailer::class)/*|*/; }", "mixed"),
            (
                "function f(EntityManagerInterface $em) { $em->getRepository(Product::class)/*|*/; }",
                "Doctrine\\ORM\\EntityRepository<App\\Entity\\Product>",
            ),
            ("function f(ProductRepository $r) { $r->findOneByName('a')/*|*/; }", "mixed"),
        ],
    );
}

#[test]
fn repository_magic_finders_are_members() {
    let file = ParsedFile::parse("main.php", "<?php\n");
    let decls = summaries(INSTALLED, &file);
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    let providers = TypeProviders::builtin();
    let names = |ty: &Type| -> Vec<String> {
        providers.magic_members(ty, &resolver, &Context::default()).into_iter().map(|member| member.name).collect()
    };
    let members = names(&Type::named("App\\Repository\\ProductRepository"));
    for name in ["findById", "findOneById", "countById", "findByName", "findOneByName", "countByName"] {
        assert!(members.iter().any(|member| member == name), "{name} missing from {members:?}");
    }
    // Static properties aren't fields.
    assert!(!members.iter().any(|member| member.contains("Instances")), "{members:?}");
    let member = providers
        .magic_member(
            &Type::named("App\\Repository\\ProductRepository"),
            "findonebyname",
            true,
            &resolver,
            &Context::default(),
        )
        .expect("findOneByName");
    assert_eq!(
        member.target,
        crate::types::provider::MagicTarget::Method {
            class: "Doctrine\\ORM\\EntityRepository".to_owned(),
            method: "findOneBy".to_owned()
        }
    );
    let tags = Type::generic("Doctrine\\ORM\\EntityRepository", vec![Type::named("App\\Entity\\Tag")]);
    assert_eq!(names(&tags), ["findByLabel", "findOneByLabel", "countByLabel"]);
    assert!(names(&Type::named("App\\Repository\\LegacyRepository")).is_empty(), "Legacy has no fields");
    assert_eq!(
        names(&Type::named("App\\Repository\\PostRepository")),
        ["findByTitle", "findOneByTitle", "countByTitle"]
    );
    assert!(names(&Type::named("App\\Repository\\OrphanRepository")).is_empty());
    assert!(names(&Type::named("App\\Service\\Mailer")).is_empty());
}

const SERVICES: &str = "\
services:
    mailer.default:
        class: App\\Service\\Mailer
    mailer: '@mailer.default'
    App\\Contract\\Sender: '@mailer.default'
    unknown.class: { class: App\\Missing }
";

fn config() -> SymfonyConfig {
    let mut config = SymfonyConfig::default();
    config.add_services(Path::new("config/services.yaml"), SERVICES);
    config.add_routes(Path::new("config/routes.yaml"), "home:\n    path: /\nabout: { path: /about }\n");
    config
}

#[test]
fn container_get_by_configured_id() {
    let config = config();
    let cases = [
        ("function f(ContainerInterface $c) { $c->get('mailer.default')/*|*/; }", "App\\Service\\Mailer"),
        ("function f(Psr $c) { $c->get('mailer')/*|*/; }", "App\\Service\\Mailer"),
        ("function f(Psr $c) { $c->get('mailer')->send('a')/*|*/; }", "bool"),
        // An interface id aliasing a service: the service's class.
        ("function f(Psr $c) { $c->get(\\App\\Contract\\Sender::class)/*|*/; }", "App\\Service\\Mailer"),
        // A class nothing declares is still named.
        ("function f(Psr $c) { $c->get('unknown.class')/*|*/; }", "App\\Missing"),
        ("function f(Psr $c) { $c->get('not.configured')/*|*/; }", "mixed"),
        ("function f(Psr $c) { $c->get(Mailer::class)/*|*/; }", "App\\Service\\Mailer"),
    ];
    for (body, expected) in cases {
        assert_eq!(type_with(INSTALLED, &config, body), expected, "{body}");
    }
    // Without the framework bundle the configuration says nothing.
    assert_eq!(type_with(&[LIBRARIES, APP], &config, "function f(Psr $c) { $c->get('mailer')/*|*/; }"), "mixed");
}

/// The route names argument 0 of `call` accepts, with the declarations of
/// `libs` and `config`.
fn routes(libs: &[&str], config: SymfonyConfig, call: ArgumentOf<'_>) -> Option<Vec<(String, Option<String>)>> {
    let file = ParsedFile::parse("main.php", "<?php\n");
    let mut decls = summaries(libs, &file);
    decls.symfony_config = config;
    let cache = TypeCache::new();
    let resolver = Resolver::new(&decls, &cache, 1);
    let known = TypeProviders::builtin().known_strings(call, 0, &resolver, &Context::default())?;
    assert_eq!(known.kind, KnownKind::Route);
    Some(known.values.into_iter().map(|value| (value.value, value.detail)).collect())
}

#[test]
fn route_names_of_the_configuration_and_the_attributes() {
    let controller = Type::named("App\\Controller\\BlogController");
    let generator = Type::named("Symfony\\Component\\Routing\\Generator\\UrlGeneratorInterface");
    let all = Some(vec![
        ("home".to_owned(), Some("/".to_owned())),
        ("about".to_owned(), Some("/about".to_owned())),
        ("blog_show".to_owned(), Some("/blog/{slug}".to_owned())),
    ]);
    assert_eq!(routes(INSTALLED, config(), ArgumentOf::Function("Main\\path")), all);
    assert_eq!(routes(INSTALLED, config(), ArgumentOf::Function("url")), all);
    let method = |receiver, name| ArgumentOf::Method { receiver, name };
    assert_eq!(routes(INSTALLED, config(), method(&controller, "generateUrl")), all);
    assert_eq!(routes(INSTALLED, config(), method(&controller, "redirectToRoute")), all);
    assert_eq!(routes(INSTALLED, config(), method(&generator, "generate")), all);
    // Other calls, receivers and arguments.
    let mailer = Type::named("App\\Service\\Mailer");
    assert_eq!(routes(INSTALLED, config(), method(&mailer, "generateUrl")), None);
    assert_eq!(routes(INSTALLED, config(), method(&controller, "generate")), None);
    assert_eq!(routes(INSTALLED, config(), ArgumentOf::Function("strlen")), None);
    // The attributes alone are enough.
    let attributes = routes(INSTALLED, SymfonyConfig::default(), ArgumentOf::Function("path"));
    assert_eq!(attributes, Some(vec![("blog_show".to_owned(), Some("/blog/{slug}".to_owned()))]));
    // No route at all, or no framework bundle: nothing is known.
    assert_eq!(routes(&[LIBRARIES, FRAMEWORK_BUNDLE], SymfonyConfig::default(), ArgumentOf::Function("path")), None);
    assert_eq!(routes(&[LIBRARIES, APP], config(), ArgumentOf::Function("path")), None);
}
